// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { evaluateQuality as evaluateUniversitySupportBaseline } from "../scripts/run-university-support-baseline.js";
import { evaluateQuality as evaluateRecorderCoherence } from "../scripts/run-live-university-recorder-coherence.js";
import { evaluateConversation as evaluateInteractiveConversation } from "../scripts/run-websocket-university-interactive.js";
import { evaluateConversation as evaluateMultiturnConversation } from "../scripts/run-websocket-university-multiturn.js";

describe("websocket smoke quality gates", () => {
  it("keeps one-turn university transcript and agent checks diagnostic", () => {
    const evaluation = evaluateUniversitySupportBaseline("", "", 0, {
      durationMs: 1000,
      bytes: 32000,
      peak: 0.2,
      rms: 0.02,
    });

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("STT missed fixture term: student name");
    expect(evaluation.diagnostics).toContain("STT missed fixture term: course");
    expect(evaluation.diagnostics).toContain("STT missed fixture term: deadline intent");
    expect(evaluation.diagnostics).toContain("STT missed fixture term: form intent");
    expect(evaluation.diagnostics).toContain("expected at least 1 tool call, got 0");
    expect(evaluation.diagnostics).toContain("agent reply did not mention the Late Add Petition");
    expect(evaluation.diagnostics).toContain("agent reply did not mention required approvals");
  });

  it("keeps one-turn university silent assistant audio as a hard failure", () => {
    const evaluation = evaluateUniversitySupportBaseline("Maya Biology deadline form", "Late Add Petition registrar.", 1, {
      durationMs: 100,
      bytes: 3200,
      peak: 0,
      rms: 0,
    });

    expect(evaluation.failures).toContain("assistant audio output is missing or effectively silent");
  });

  it("keeps interactive fixture transcript and agent wording checks diagnostic", () => {
    const evaluation = evaluateInteractiveConversation([
      {
        id: "turn-1",
        fixtureId: "fixture-1",
        inputText: "expected fixture text",
        requiredTerms: ["biology"],
        inputAudioMs: 1000,
        startedAtMs: 0,
        speechStartedAtMs: 10,
        speechStartedCount: 1,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        speechEndedCount: 1,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        agentEndedAtMs: 1800,
        ttsEndedAtMs: 2200,
        transcript: "hello",
        agentReply: "ok",
        toolCalls: [],
        audioBytes: 32000,
        metricsE2eMs: 0,
        error: "",
      },
    ]);

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("turn-1 STT transcript missed fixture term biology");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply did not end cleanly");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply was short");
  });

  it("keeps multiturn tool and agent-content checks diagnostic", () => {
    const evaluation = evaluateMultiturnConversation([
      {
        id: "turn-1",
        fixtureId: "fixture-1",
        inputText: "expected fixture text",
        inputAudioMs: 1000,
        startedAtMs: 0,
        speechStartedAtMs: 10,
        speechStartedCount: 1,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        speechEndedCount: 1,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        agentEndedAtMs: 1800,
        ttsEndedAtMs: 2200,
        transcript: "hello",
        agentReply: "ok",
        toolCalls: [],
        audioChunks: [new Uint8Array(24000)],
        error: "",
      },
    ], 1000);

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("modeled conversation was 1000ms, expected at least 480000ms");
    expect(evaluation.diagnostics).toContain("expected tools on at least half of turns, got 0 calls across 1 turns");
    expect(evaluation.diagnostics).toContain("expected tool call missing on turn-1");
    expect(evaluation.diagnostics).toContain("first STT transcript missed fixture term Biology");
    expect(evaluation.diagnostics).toContain("first reply missed late add guidance");
    expect(evaluation.diagnostics).toContain("agent never referenced the Student Relations case number");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply did not end cleanly");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply was short");
  });

  it("keeps live recorder tool and TTS punctuation checks diagnostic", () => {
    const evaluation = evaluateRecorderCoherence([
      {
        id: "live-turn-01",
        fixtureId: "fixture-1",
        inputText: "expected fixture text",
        inputAudioMs: 1000,
        userRecorderOffsetBytes: 0,
        userRecorderByteLength: 32000,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        ttsEndedAtMs: 2200,
        sttTranscript: "hello",
        agentReply: "ok",
        spokenReply: "spoken reply",
        toolCalls: [],
        assistantAudioBytes: 48000,
        assistantAudioChunks: [new Uint8Array(48000)],
        assistantPlayoutEndMs: 2200,
        error: "",
      },
      {
        id: "live-turn-02",
        fixtureId: "fixture-2",
        inputText: "expected fixture text",
        inputAudioMs: 1000,
        userRecorderOffsetBytes: 32000,
        userRecorderByteLength: 32000,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        ttsEndedAtMs: 2200,
        sttTranscript: "hello",
        agentReply: "ok",
        spokenReply: "spoken reply.",
        toolCalls: ["studentRelationsLookup"],
        assistantAudioBytes: 48000,
        assistantAudioChunks: [new Uint8Array(48000)],
        assistantPlayoutEndMs: 2200,
        error: "",
      },
      {
        id: "live-turn-03",
        fixtureId: "fixture-3",
        inputText: "expected fixture text",
        inputAudioMs: 1000,
        userRecorderOffsetBytes: 64000,
        userRecorderByteLength: 32000,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        ttsEndedAtMs: 2200,
        sttTranscript: "hello",
        agentReply: "ok",
        spokenReply: "spoken reply.",
        toolCalls: ["studentRelationsLookup"],
        assistantAudioBytes: 48000,
        assistantAudioChunks: [new Uint8Array(48000)],
        assistantPlayoutEndMs: 2200,
        error: "",
      },
    ], {
      schemaVersion: 1,
      startedAtMs: 0,
      closedAtMs: 1,
      files: {
        directory: "/tmp/session",
        eventsPath: "/tmp/session/events.jsonl",
        userAudioPath: "/tmp/session/user_audio.pcm",
        assistantAudioPath: "/tmp/session/assistant_audio.pcm",
        manifestPath: "/tmp/session/manifest.json",
      },
      audio: {
        user: {
          path: "/tmp/session/user_audio.pcm",
          sampleRateHz: 16000,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: 96000,
          durationMs: 3000,
          chunks: 3,
        },
        assistant: {
          path: "/tmp/session/assistant_audio.pcm",
          sampleRateHz: 24000,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: 144000,
          durationMs: 3000,
          chunks: 3,
          truncations: 0,
        },
      },
      events: {
        path: "/tmp/session/events.jsonl",
        packets: 1,
        byteLength: 1,
      },
    }, "user whisper", "assistant whisper", 0);

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("live-turn-01 did not call studentRelationsLookup");
    expect(evaluation.diagnostics).toContain("live-turn-01 TTS text did not end cleanly");
  });
});
