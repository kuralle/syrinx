// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOptions, warningsFor, type RawFlags } from "./options.js";
import { CliError, EXIT_CODES } from "./exit-codes.js";

const SLICE: RawFlags = { stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser" };

describe("resolveOptions", () => {
  it("resolves the cascade slice with defaults (transport=browser, runtime=node)", () => {
    const opts = resolveOptions(SLICE, ["my-agent"]);
    expect(opts).toMatchObject({
      mode: "cascade",
      stt: "deepgram",
      tts: "cartesia",
      reasoner: "aisdk",
      transport: "browser",
      runtime: "node",
      name: "my-agent",
    });
  });

  it("derives the project name from the target directory positional", () => {
    const opts = resolveOptions(SLICE, ["path/to/my-agent"]);
    expect(opts.name).toBe("my-agent");
  });

  it("--name overrides the positional", () => {
    const opts = resolveOptions({ ...SLICE, name: "explicit-name" }, ["ignored-dir"]);
    expect(opts.name).toBe("explicit-name");
  });

  it("refuses --realtime combined with --stt/--tts, naming both flags", () => {
    expect(() => resolveOptions({ realtime: "realtime", stt: "deepgram", tts: "cartesia" }, ["x"])).toThrow(
      /--stt and --tts/,
    );
  });

  it("refuses --realtime combined with --stt alone, naming only --stt", () => {
    try {
      resolveOptions({ realtime: "realtime", stt: "deepgram" }, ["x"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
      expect((err as CliError).message).toMatch(/--stt/);
      expect((err as CliError).message).not.toMatch(/--tts/);
    }
  });

  it("resolves a realtime (speech-to-speech) selection", () => {
    const opts = resolveOptions({ realtime: "grok" }, ["x"]);
    expect(opts).toMatchObject({ mode: "realtime", realtime: "grok" });
  });

  it("lists every missing required cascade flag", () => {
    expect(() => resolveOptions({}, ["x"])).toThrow(/--stt, --tts, --reasoner/);
  });

  it("requires a target directory or --name", () => {
    expect(() => resolveOptions(SLICE, [])).toThrow(/target directory or --name/);
  });

  it("rejects an unknown --stt value, listing the valid ones", () => {
    expect(() => resolveOptions({ ...SLICE, stt: "not-a-provider" }, ["x"])).toThrow(
      /--stt must be one of: deepgram, google, elevenlabs, grok/,
    );
  });

  it("applies a preset, letting an explicit flag override one preset field", () => {
    const opts = resolveOptions({ preset: "phone", tts: "elevenlabs" }, ["x"]);
    expect(opts).toMatchObject({ mode: "cascade", stt: "deepgram", tts: "elevenlabs", transport: "twilio" });
  });

  it("rejects an unknown --preset", () => {
    expect(() => resolveOptions({ preset: "not-a-preset" }, ["x"])).toThrow(/--preset must be one of/);
  });

  it("--no-install / --skip-install / --dry-run map to the resolved flags", () => {
    const opts = resolveOptions({ ...SLICE, "no-install": true, "dry-run": true }, ["x"]);
    expect(opts.skipInstall).toBe(true);
    expect(opts.dryRun).toBe(true);
  });
});

describe("warningsFor", () => {
  it("warns on runtime=cloudflare + transport=telnyx, naming both", () => {
    const opts = resolveOptions({ ...SLICE, transport: "telnyx", runtime: "cloudflare" }, ["x"]);
    const warnings = warningsFor(opts);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cloudflare/);
    expect(warnings[0]).toMatch(/telnyx/);
  });

  it("emits no warning for the node+browser slice", () => {
    const opts = resolveOptions(SLICE, ["x"]);
    expect(warningsFor(opts)).toEqual([]);
  });

  it("emits no warning for runtime=cloudflare + transport=browser", () => {
    const opts = resolveOptions({ ...SLICE, runtime: "cloudflare" }, ["x"]);
    expect(warningsFor(opts)).toEqual([]);
  });
});

describe("target directory resolution", () => {
  const base = { stt: "deepgram", tts: "cartesia", reasoner: "aisdk" } as const;

  it("writes to the path given, not to ./<name>", () => {
    // Regression: the generator used to pass `name` as the destination, so an
    // absolute target silently scattered a project into the caller's cwd.
    const opts = resolveOptions({ ...base }, ["/tmp/somewhere/my-agent"]);
    expect(opts.targetDir).toBe("/tmp/somewhere/my-agent");
    expect(opts.name).toBe("my-agent");
  });

  it("resolves a relative target against cwd", () => {
    const opts = resolveOptions({ ...base }, ["nested/dir/agent"]);
    expect(opts.targetDir).toBe(resolve(process.cwd(), "nested/dir/agent"));
    expect(opts.name).toBe("agent");
  });

  it("falls back to --name when no positional is given", () => {
    const opts = resolveOptions({ ...base, name: "solo" }, []);
    expect(opts.targetDir).toBe(resolve(process.cwd(), "solo"));
    expect(opts.name).toBe("solo");
  });
});
