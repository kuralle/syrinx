import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import { VoiceAgentSession } from "./voice-agent-session.js";
import type { VoicePacket } from "./packets.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const closedUnionSwitches = new Set([
  // These switches intentionally handle closed InteractionDecision and InteractionObservation unions, not VoicePacket.
  "interaction-coordinator.ts",
  "policies/rule-based.ts",
]);

interface UnknownPacket extends VoicePacket {
  readonly payload: { readonly vendor: string };
}

function unknownPacket(contextId: string): UnknownPacket {
  return {
    kind: "acme.frame",
    contextId,
    timestampMs: Date.now(),
    payload: { vendor: "acme" },
  };
}

function waitForDrain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function switchBody(source: string, openingBrace: number): string {
  let depth = 0;
  for (let i = openingBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, i);
    }
  }
  return source.slice(openingBrace + 1);
}

function exhaustiveKindSwitches(source: string): Array<{ line: number; body: string }> {
  const switches: Array<{ line: number; body: string }> = [];
  const pattern = /switch\s*\(\s*[A-Za-z_$][\w$]*\.kind\s*\)\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const openingBrace = (match.index ?? 0) + match[0].length - 1;
    const body = switchBody(source, openingBrace);
    const defaultBranch = /\bdefault\s*:[\s\S]*/.exec(body)?.[0] ?? "";
    if (/:\s*never\b|assertNever\s*\(|exhaustive\s*\(/.test(defaultBranch)) {
      switches.push({
        line: source.slice(0, match.index ?? 0).split("\n").length,
        body,
      });
    }
  }
  return switches;
}

describe("VoicePacket open-forwarding guarantee", () => {
  it("keeps VoicePacket.kind open to vendor strings", () => {
    expectTypeOf<VoicePacket["kind"]>().toEqualTypeOf<string>();
    const k: VoicePacket["kind"] = "acme.frame";
    expect(k).toBe("acme.frame");
  });

  it("forwards an unknown kind through PipelineBus without errors or drops", async () => {
    const received: VoicePacket[] = [];
    const emitted: VoicePacket[] = [];
    const dropped: VoicePacket[] = [];
    const pipelineErrors: VoicePacket[] = [];
    const bus = new PipelineBusImpl({
      mainCapacity: 1,
      onMainDrop: (packet) => { dropped.push(packet); },
      onPacket: (_route, packet) => { emitted.push(packet); },
    });
    bus.on("acme.frame", (packet) => { received.push(packet); });
    bus.on("pipeline.error", (packet) => { pipelineErrors.push(packet); });
    const draining = bus.start();

    const packet = unknownPacket("bus-context");
    bus.push(Route.Main, packet);
    await waitForDrain();
    bus.stop();
    await draining;

    expect(received).toEqual([packet]);
    expect(pipelineErrors).toEqual([]);
    expect(dropped).toEqual([]);
    expect(emitted.filter((candidate) => candidate.kind === "pipeline.error")).toEqual([]);
    expect(emitted.filter((candidate) => candidate.kind.startsWith("pipeline.bus."))).toEqual([]);
  });

  it("forwards an unknown kind through VoiceAgentSession without throwing or warning", async () => {
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: VoicePacket[] = [];
    const session = new VoiceAgentSession({ plugins: {} });
    session.bus.on("acme.frame", (packet) => { received.push(packet); });

    try {
      await session.start();
      const packet = unknownPacket("session-context");
      expect(() => session.bus.push(Route.Main, packet)).not.toThrow();
      await waitForDrain();
      expect(received).toEqual([packet]);
      expect(warningSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await session.close();
      warningSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("rejects exhaustive VoicePacket kind switches in core source", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const relative = file.slice(sourceRoot.length).replace(/^\/+/, "");
      const switches = exhaustiveKindSwitches(readFileSync(file, "utf8"));
      if (closedUnionSwitches.has(relative)) continue;
      for (const found of switches) violations.push(`${relative}:${String(found.line)}`);
    }

    expect(violations).toEqual([]);
  });
});
