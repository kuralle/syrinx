// SPDX-License-Identifier: MIT
//
// Bi-model VoiceAgentSession for Cloudflare Workers: gpt-realtime-2 front model
// dialed via createWorkersSocket, with an async university Reasoner back model.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";
import { tool, stepCountIs } from "ai";
import { z } from "zod";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";

export interface RealtimeSessionEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
}

export interface RealtimeSessionOptions {
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
}

const DEFAULT_REASONER_MODEL = "gpt-4.1-mini";

const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const UNIVERSITY_SUPPORT_PROMPT = [
  "You are Syrinx University's Student Relations voice agent.",
  "For enrollment, add-drop, advising, account, or case-status questions, call resolveLateAddRequest before answering.",
  "Never invent deadlines, forms, URLs, account holds, or approvals. If a tool result is incomplete, say what must be checked next.",
  "For spoken replies, use two concise sentences maximum and lead with the student action.",
  "If transcription sounds uncertain, ask one short clarification instead of guessing.",
].join("\n");

const supportTools = {
  resolveLateAddRequest: tool({
    description: "Resolve a student's late add request, including student status, policy, form, approvals, and case creation.",
    inputSchema: z.object({
      studentId: z.string().optional().describe("Student ID if the caller provided one."),
      name: z.string().optional().describe("Student name if the caller provided one."),
      courseCode: z.string().optional().describe("Course code or spoken course name."),
      term: z.string().optional().describe("Academic term if known."),
    }),
    execute: async ({ studentId, name, courseCode, term }) => ({
      student: {
        studentId: studentId ?? "S10042",
        name: name ?? "Maya Chen",
        academicStanding: "good",
        activeHolds: [],
        advisor: "Dr. Priya Raman",
      },
      policy: {
        courseCode: courseCode ?? "Biology 101",
        term: term ?? "Spring 2027",
        addDeadline: "2027-02-05",
        today: "2027-02-09",
        status: "late_add_required",
        requiredForm: "Late Add Petition",
        approvals: ["course instructor", "academic advisor", "registrar"],
        submissionChannel: "Student Relations portal",
      },
      case: {
        caseId: "SR-2027-004812",
        nextStep:
          "Submit the Late Add Petition in the Student Relations portal and route it to the instructor, advisor, and registrar.",
      },
    }),
  }),
};

export function hasRealtimeSessionCredentials(env: RealtimeSessionEnv): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export function createRealtimeVoiceAgentSession(
  env: RealtimeSessionEnv,
  _options: RealtimeSessionOptions = {},
): VoiceAgentSession {
  const openaiKey = requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");

  const adapter = fromOpenAIRealtime({
    apiKey: openaiKey,
    socketFactory: createWorkersSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    inputTranscription: true,
    tools: [ASK_UNIVERSITY_TOOL],
  });

  const universityReasoner = fromStreamText({
    model: createOpenAI({ apiKey: openaiKey })(env.OPENAI_MODEL ?? DEFAULT_REASONER_MODEL),
    system: UNIVERSITY_SUPPORT_PROMPT,
    tools: supportTools,
    temperature: 0.2,
    maxOutputTokens: 180,
    maxRetries: 0,
    timeout: 45_000,
    stopWhen: stepCountIs(4),
  });

  const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  return session;
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a realtime voice session`);
  return trimmed;
}
