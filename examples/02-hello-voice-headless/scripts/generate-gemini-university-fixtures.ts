// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
} from "@asyncdot/voice";
import { GeminiTTSPlugin } from "@asyncdot/voice-tts-gemini";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(SCRIPT_DIR, "..");
export const GEMINI_UNIVERSITY_FIXTURE_DIR = join(PKG_ROOT, "test", "fixtures", "gemini-university-support");
export const GEMINI_UNIVERSITY_MANIFEST_PATH = join(GEMINI_UNIVERSITY_FIXTURE_DIR, "manifest.json");

export interface GeminiUniversityFixture {
  readonly id: string;
  readonly text: string;
  readonly path: string;
}

export const GEMINI_UNIVERSITY_FIXTURES: readonly GeminiUniversityFixture[] = [
  {
    id: "01-late-add",
    text:
      "Hi, I'm Maya Chen, student ID S one zero zero four two. I missed the normal add deadline because the Biology one oh one lab seat opened after my wait list cleared this morning. I need to know whether I can still add the lecture and lab together, what form I should submit, and whether I should contact the instructor before I file anything.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "01-late-add.wav"),
  },
  {
    id: "02-registration-holds",
    text:
      "Thanks, that makes sense. Before I start the petition, can you check whether I have any registration holds that would block the late add from going through? I paid my balance yesterday, but the student portal still showed a warning this morning, and I do not want the instructor approval to expire while I wait.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "02-registration-holds.wav"),
  },
  {
    id: "03-financial-aid",
    text:
      "If the course is added late, I also need to understand whether it changes my financial aid status. I am currently at nine enrolled credits, Biology would put me at twelve, and my scholarship office told me full time status has to be reflected before their review on Friday afternoon.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "03-financial-aid.wav"),
  },
  {
    id: "04-advisor-approval",
    text:
      "My academic advisor is Dr. Priya Raman, but she is at a conference this week. If the petition needs advisor approval, can Student Relations route it to a backup advisor, or do I need to wait for her to respond directly?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "04-advisor-approval.wav"),
  },
  {
    id: "05-instructor-email",
    text:
      "The instructor told me over email that I can join if the department confirms the lab seat. Should I upload that email with the petition, and should the department approval be attached separately or can it be added after I submit the case?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "05-instructor-email.wav"),
  },
  {
    id: "06-international-status",
    text:
      "One more concern is my international student status. I am on an F one visa, and dropping below full time was only temporary while I waited for this lab. Do I need to notify the international office before the late add is approved, or only if the petition is denied?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "06-international-status.wav"),
  },
  {
    id: "07-housing",
    text:
      "I also live in university housing, and their renewal form asks whether I am full time for the spring term. If the late add is pending, what should I tell housing so they do not mark my renewal as incomplete?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "07-housing.wav"),
  },
  {
    id: "08-accessibility",
    text:
      "I have an accessibility accommodation for lab scheduling because I cannot attend sections that start before nine in the morning. The open lab section is at eight thirty. Is that something Student Relations can include in the case, or should I contact the accessibility office first?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "08-accessibility.wav"),
  },
  {
    id: "09-athletics",
    text:
      "I am also on the varsity tennis roster, and the athletics academic coordinator asked for confirmation that the late add will not conflict with travel letters. Can your office add the coordinator as a watcher on the case, or do I need to forward updates manually?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "09-athletics.wav"),
  },
  {
    id: "10-lab-fee",
    text:
      "Does Biology one oh one have a separate lab fee that appears after the late add is approved? If there is a fee, I need to know whether it posts immediately or after the registrar processes the petition, because that changes how I plan my payment.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "10-lab-fee.wav"),
  },
  {
    id: "11-case-open",
    text:
      "Please open a Student Relations case for me now with the late add request, the possible financial aid impact, the visa status note, and the accommodation concern. I want the case summary to be clear enough that the registrar does not have to ask me the same questions again.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "11-case-open.wav"),
  },
  {
    id: "12-next-steps",
    text:
      "After the case is opened, can you give me the next steps in order? I need to know exactly who I should contact first today, what documents I should upload, and what deadline I should watch so this does not roll into next week.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "12-next-steps.wav"),
  },
  {
    id: "13-clarify-deadline",
    text:
      "You mentioned a deadline earlier. Can you clarify whether that is the deadline for me to submit the petition, the deadline for the instructor to approve it, or the deadline for the registrar to finish processing it?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "13-clarify-deadline.wav"),
  },
  {
    id: "14-appointment",
    text:
      "If this gets complicated, I would like an appointment with Student Relations tomorrow afternoon. I am free after two thirty, and I would prefer a video appointment because I will be at my lab orientation.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "14-appointment.wav"),
  },
  {
    id: "15-summary",
    text:
      "Before we finish, please summarize what you found, what case number I should reference, and what I should do today versus what I can wait on. I want to write it down so I do not miss anything.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "15-summary.wav"),
  },
  {
    id: "16-goodbye",
    text:
      "That answers my questions. Please make sure the case notes include that I am trying to reach full time status for financial aid and visa compliance, not just adding the class for convenience.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "16-goodbye.wav"),
  },
  {
    id: "17-parent-consent",
    text:
      "I forgot one detail. My parent is an authorized payer on my account, but I do not want them to receive the case notes about visa status. Can you tell me whether billing delegates can see Student Relations notes, or only the charges that result from the lab fee?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "17-parent-consent.wav"),
  },
  {
    id: "18-department-seat",
    text:
      "The department coordinator just emailed me while we are talking and said the lab seat is reserved until tomorrow at noon. Should I reply to them first, or is it better to upload the email and let Student Relations contact the department through the case?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "18-department-seat.wav"),
  },
  {
    id: "19-class-attendance",
    text:
      "I already attended the first lecture and one lab as a guest because the instructor allowed it. Does that help the petition, and should I include the dates I attended so the registrar knows I have not missed the required safety orientation?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "19-class-attendance.wav"),
  },
  {
    id: "20-refund-risk",
    text:
      "If the petition is denied, I may need to add a different three credit course instead. Can you tell me whether there is a refund or tuition adjustment risk if I wait until after the registrar decision to choose a backup class?",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "20-refund-risk.wav"),
  },
  {
    id: "21-appeal-path",
    text:
      "If the registrar says no, is there an appeal path through Student Relations, or would that go through my college dean? I am asking because the wait list timing was outside my control, and I want to know what evidence matters most.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "21-appeal-path.wav"),
  },
  {
    id: "22-notification-preference",
    text:
      "Please set my notification preference to email first and text second if that is available. I am in lab most afternoons, so a phone call may go to voicemail, but I can reply to email quickly during breaks.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "22-notification-preference.wav"),
  },
  {
    id: "23-readback",
    text:
      "Can you read back the case summary before we close it? I want to make sure it includes the late add petition, the lab seat reservation, financial aid full time status, international office notification, and the accessibility scheduling issue.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "23-readback.wav"),
  },
  {
    id: "24-final-confirmation",
    text:
      "Okay, final confirmation. I will upload the instructor email and department seat confirmation today, notify international student services, and watch for the video appointment tomorrow at two forty five. Please tell me if that is the right plan.",
    path: join(GEMINI_UNIVERSITY_FIXTURE_DIR, "24-final-confirmation.wav"),
  },
];

export interface PcmWav {
  readonly samples: Int16Array;
  readonly sampleRate: number;
}

export async function ensureGeminiUniversityFixtures(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY is required");

  await mkdir(GEMINI_UNIVERSITY_FIXTURE_DIR, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    provider: "gemini-tts",
    model: geminiTtsModel(),
    voiceName: geminiTtsVoiceName(),
    sampleRateHz: 24000,
    fixtures: [] as Array<{ id: string; text: string; path: string; durationMs: number; bytes: number }>,
  };

  for (const fixture of GEMINI_UNIVERSITY_FIXTURES) {
    if (!existsSync(fixture.path)) {
      console.log(`synthesizing ${fixture.id}`);
      const wav = await synthesizeFixture(fixture.text, apiKey);
      await writeFile(fixture.path, Buffer.from(wav.toBuffer()));
      console.log(`wrote ${fixture.path}`);
    } else {
      console.log(`reusing ${fixture.id}`);
    }
    const pcm = readPcm16Wav(fixture.path);
    manifest.fixtures.push({
      id: fixture.id,
      text: fixture.text,
      path: fixture.path.replace(`${PKG_ROOT}/`, ""),
      durationMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000),
      bytes: readFileSync(fixture.path).byteLength,
    });
  }

  await writeFile(GEMINI_UNIVERSITY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function readPcm16Wav(path: string): PcmWav {
  const wav = new WaveFile(Buffer.from(readFileSync(path)));
  const fmt = wav.fmt as {
    sampleRate: number;
    numChannels: number;
    bitsPerSample: number;
    audioFormat: number;
  };
  if (fmt.numChannels !== 1) throw new Error(`expected mono WAV, got ${String(fmt.numChannels)} channels`);
  if (fmt.bitsPerSample !== 16 || fmt.audioFormat !== 1) throw new Error("expected 16-bit PCM WAV");
  const raw = wav.getSamples(false, Int16Array);
  const samples: Int16Array | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (!(samples instanceof Int16Array)) throw new Error(`WAV has no PCM16 mono samples: ${path}`);
  return { samples, sampleRate: fmt.sampleRate };
}

async function synthesizeFixture(text: string, apiKey: string): Promise<{ toBuffer(): Uint8Array }> {
  const bus = new PipelineBusImpl();
  const tts = new GeminiTTSPlugin();
  const chunks: Uint8Array[] = [];
  const contextId = `gemini-fixture-${Date.now()}`;
  const busPump = bus.start();

  const done = new Promise<void>((resolveDone, reject) => {
    const timeout = setTimeout(() => reject(new Error("Gemini TTS fixture synthesis timeout")), 180_000);
    const offAudio = bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
      if (pkt.contextId === contextId) chunks.push(pkt.audio);
    });
    const offEnd = bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (pkt.contextId !== contextId) return;
      clearTimeout(timeout);
      offAudio();
      offEnd();
      offError();
      resolveDone();
    });
    const offError = bus.on<TtsErrorPacket>("tts.error", (pkt) => {
      if (pkt.contextId !== contextId) return;
      clearTimeout(timeout);
      offAudio();
      offEnd();
      offError();
      reject(pkt.cause);
    });
  });

  await tts.initialize(bus, {
    api_key: apiKey,
    model: geminiTtsModel(),
    voice_name: geminiTtsVoiceName(),
    retry_max_attempts: 2,
  });

  bus.push(Route.Main, {
    kind: "tts.text",
    contextId,
    timestampMs: Date.now(),
    text,
  });
  bus.push(Route.Main, {
    kind: "tts.done",
    contextId,
    timestampMs: Date.now(),
    text,
  });

  try {
    await done;
  } finally {
    await tts.close();
    bus.stop();
    await busPump;
  }

  const bytes = mergeBytes(chunks);
  if (bytes.byteLength === 0) throw new Error("Gemini TTS returned no audio");

  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, 24000, "16", samples);
  return wav;
}

function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function geminiTtsModel(): string {
  return process.env["SYRINX_GEMINI_TTS_MODEL"]?.trim() || "gemini-2.5-flash-preview-tts";
}

function geminiTtsVoiceName(): string {
  return process.env["SYRINX_GEMINI_TTS_VOICE"]?.trim() || "Kore";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void ensureGeminiUniversityFixtures().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
