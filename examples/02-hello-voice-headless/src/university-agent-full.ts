// SPDX-License-Identifier: MIT

import { createOpenAI } from "@ai-sdk/openai";
import {
  defineAgent,
  defineFlow,
  defineTool,
  buildToolSet,
  createRuntime,
  MemoryStore,
  reply,
  type Runtime,
} from "@kuralle-agents/core";
import {
  AiSdkEmbedder,
  InMemoryVectorStore,
  VectorRetriever,
  createMarkdownChunker,
  createStaticKnowledgeSource,
} from "@kuralle-agents/rag";
import { defineSkill } from "@kuralle-agents/skills";
import { z } from "zod";

import { DEFAULT_MODEL } from "./run-one-turn.js";

const CORPUS: ReadonlyArray<{ id: string; name: string; content: string }> = [
  {
    id: "admissions",
    name: "Admissions",
    content: `# Admissions

## Computer Science Masters Application

The application deadline for the computer science masters program is **March 31**.

### Required Documents
- Official transcript
- Statement of purpose (SOP)
- Two letters of recommendation
`,
  },
  {
    id: "cs-program",
    name: "CS Program",
    content: `# Computer Science Masters

The CS masters program requires **30 credits** to graduate.

## Prerequisites
- Data structures
- Linear algebra

GRE scores are optional for admission.
`,
  },
  {
    id: "tuition",
    name: "Tuition",
    content: `# Tuition and Fees

In-state tuition is **$15,000 per semester**.

Mandatory fees are **$800** per semester.
`,
  },
  {
    id: "scholarships",
    name: "Scholarships",
    content: `# Scholarships

## Dean's Merit Scholarship
Awarded to students with GPA **≥ 3.5**.

## Need-Based Grant
Requires a completed **FAFSA**.

The scholarship application deadline is **February 15**.
`,
  },
];

const SCHOLARSHIP_SKILL = defineSkill({
  name: "scholarship-guidance",
  description: "Guide students through scholarship eligibility and application steps",
  body: `# Scholarship Guidance

1. Ask whether the student is seeking merit-based aid, need-based aid, or both.
2. For merit: cite the Dean's Merit Scholarship (GPA ≥ 3.5).
3. For need: cite the Need-Based Grant (FAFSA required).
4. Always mention the application deadline of February 15.`,
  allowedTools: [],
});

let bookingCounter = 0;

const createBookingTool = defineTool({
  name: "create_booking",
  description: "Finalize the advisor appointment booking. Only call after the user has explicitly confirmed the details.",
  input: z.object({}),
  execute: async () => {
    bookingCounter += 1;
    return { bookingRef: `ADV-${bookingCounter}` };
  },
});

const recordBookingDetails = defineTool({
  name: "record_booking_details",
  description:
    "Record the student's name, program, and preferred date once all three are known. preferredDate may be natural language such as 'this Friday'.",
  input: z.object({ name: z.string(), program: z.string(), preferredDate: z.string() }),
  execute: async (details) => details,
});

const requestTranscriptTool = defineTool({
  name: "request_transcript",
  description: "Submit an official transcript request for the given studentId.",
  input: z.object({ studentId: z.string() }),
  execute: async ({ studentId }) => ({ requestRef: `TR-${studentId}` }),
});

// One reply node per flow: phase-aware instructions + next() stays after each tool
// transition so each user turn emits a single utterance (no {goto} same-turn chains).

const bookingTurn = reply({
  id: "book-advisor",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) => {
    if (state["bookingRef"]) {
      return `The advisor appointment is booked. Confirm it to the user and include this exact reference verbatim: ${String(state["bookingRef"])}.`;
    }
    if (state["name"] && state["program"] && state["preferredDate"]) {
      return `Summarize the advisor appointment — name: ${String(state["name"])}, program: ${String(state["program"])}, date: ${String(state["preferredDate"])} — and ask the user to confirm. ONLY when the user clearly confirms, call create_booking. After create_booking returns, repeat the bookingRef from the tool result verbatim in your reply.`;
    }
    return `Help the user book an advisor appointment. Read the latest user message for name, program, and preferred date. When all three are present — including relative dates like "this Friday" — call record_booking_details immediately with those values. When name, program, and preferredDate are already in flow state, summarize them and ask the user to confirm before calling create_booking. Do not ask for a field the user already provided.`;
  },
  tools: buildToolSet({ record_booking_details: recordBookingDetails, create_booking: createBookingTool }),
  next: (turn, state) => {
    const booked = turn.toolResults.find((t) => t.name === "create_booking");
    if (booked?.result && typeof booked.result === "object") {
      Object.assign(state, booked.result);
      return { end: "booked" };
    }
    const recorded = turn.toolResults.find((t) => t.name === "record_booking_details");
    if (recorded?.result && typeof recorded.result === "object") {
      Object.assign(state, recorded.result);
    }
    return "stay";
  },
});

const bookingFlow = defineFlow({
  name: "book-advisor-appointment",
  description: "Book an appointment with an academic advisor",
  start: bookingTurn,
  nodes: [bookingTurn],
});

const transcriptTurn = reply({
  id: "request-transcript",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) => {
    if (state["requestRef"]) {
      return `Confirm the transcript request was submitted. Include this exact request reference verbatim: ${String(state["requestRef"])}.`;
    }
    return `Help the user request an official transcript. Ask only if student ID is missing. When the student ID is in the user's latest message, call request_transcript immediately and confirm with the requestRef from the tool result.`;
  },
  tools: buildToolSet({ request_transcript: requestTranscriptTool }),
  next: (turn, state) => {
    const r = turn.toolResults.find((t) => t.name === "request_transcript");
    if (r?.result && typeof r.result === "object") {
      Object.assign(state, r.result);
      return { end: "requested" };
    }
    return "stay";
  },
});

const transcriptFlow = defineFlow({
  name: "request-transcript",
  description: "Request an official academic transcript",
  start: transcriptTurn,
  nodes: [transcriptTurn],
});

export interface FullUniversityRuntime {
  readonly runtime: Runtime;
  readonly ingestMs: number;
}

export interface FullUniversityRuntimeOptions {
  /** true (guaranteed) = pre-inject RAG every answering turn; false (on-demand) = wire a
   *  knowledge_search tool the model calls only when answering (routing turns pay no tax). */
  readonly autoRetrieve?: boolean;
  /** Optional runtime hooks. */
  readonly hooks?: Parameters<typeof createRuntime>[0]["hooks"];
  /** Cost instrumentation: called with each OpenAI `usage` object (chat/completions, Responses API, or embeddings). */
  readonly onUsage?: (usage: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    input_tokens?: number; output_tokens?: number;
  }) => void;
}

export async function createFullUniversityRuntime(
  opts: FullUniversityRuntimeOptions = {},
): Promise<FullUniversityRuntime> {
  const autoRetrieve = opts.autoRetrieve ?? true;
  const apiKey = requireEnv("OPENAI_API_KEY");
  const onUsage = opts.onUsage;
  const usageFetch: typeof fetch = onUsage
    ? async (input, init) => {
        // Inject stream_options.include_usage so streamed chat completions emit a usage chunk.
        if (init?.body && typeof init.body === "string" && init.body.includes('"messages"')) {
          try {
            const body = JSON.parse(init.body) as Record<string, unknown>;
            if (body["stream"] === true && body["stream_options"] === undefined) {
              body["stream_options"] = { include_usage: true };
              init = { ...init, body: JSON.stringify(body) };
            }
          } catch { /* leave body as-is */ }
        }
        const res = await fetch(input as RequestInfo, init as RequestInit);
        try {
          const text = await res.clone().text();
          for (const raw of text.split("\n")) {
            const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
            if (!line || line === "[DONE]") continue;
            try {
              const obj = JSON.parse(line) as { usage?: Record<string, number>; response?: { usage?: Record<string, number> } };
              const usage = obj.usage ?? obj.response?.usage;
              if (usage) onUsage(usage);
            } catch { /* not JSON line */ }
          }
        } catch { /* clone/read failed */ }
        return res;
      }
    : fetch;
  const openai = createOpenAI(onUsage ? { apiKey, fetch: usageFetch } : { apiKey });
  const model = openai(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL);
  const embedder = new AiSdkEmbedder({ model: openai.embedding("text-embedding-3-small") });
  const store = new InMemoryVectorStore();

  await store.createIndex({ indexName: "university-kb", dimension: 1536 });

  const ingestStart = performance.now();
  const chunker = createMarkdownChunker();
  for (const doc of CORPUS) {
    const src = createStaticKnowledgeSource({
      id: doc.id,
      name: doc.name,
      content: doc.content,
      chunker,
    });
    const chunks = src.getChunks();
    const vecs = await embedder.embedMany(chunks.map((c) => c.text));
    await store.upsert(
      "university-kb",
      chunks.map((c, i) => ({
        id: `${doc.id}:${c.id}`,
        vector: vecs[i]!,
        document: c.text,
        metadata: { sourceId: doc.id },
      })),
    );
  }
  const ingestMs = performance.now() - ingestStart;

  const retriever = new VectorRetriever({
    vectorStore: store,
    embedder,
    indexName: "university-kb",
    topK: 3,
  });

  const agent = defineAgent({
    id: "university",
    model,
    instructions:
      "You are a friendly university support assistant. Answer admissions, program, tuition, and scholarship questions clearly and concisely for voice.",
    knowledge: { autoRetrieve },
    skills: [SCHOLARSHIP_SKILL],
    flows: [bookingFlow, transcriptFlow],
    tools: {
      create_booking: createBookingTool,
      request_transcript: requestTranscriptTool,
    },
    memory: { workingMemory: { autoLoad: [{ scope: "user", key: "USER" }] } },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: "university",
    sessionStore: new MemoryStore(),
    knowledge: { retriever, embedder },
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });

  return { runtime, ingestMs };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
