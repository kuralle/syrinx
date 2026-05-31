// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  fuseEndpointDecision,
  scoreSemanticCompleteness,
  type SemanticEndpointFusionConfig,
} from "./semantic-completeness.js";
import { SEMANTIC_LABELED_UTTERANCES } from "./semantic-fixtures.js";

const fusionConfig: SemanticEndpointFusionConfig = {
  enabled: true,
  finalizeDelayMs: 250,
  semanticShortcutDelayMs: 50,
  incompleteFallbackMs: 2000,
};

describe("scoreSemanticCompleteness", () => {
  it("labels complete utterances as complete", () => {
    for (const fixture of SEMANTIC_LABELED_UTTERANCES.filter((item) => item.category === "complete")) {
      const score = scoreSemanticCompleteness(fixture.text);
      expect(score.complete, fixture.id).toBe(true);
      expect(score.label).toBe("complete");
    }
  });

  it("labels mid-thought pauses as incomplete", () => {
    for (const fixture of SEMANTIC_LABELED_UTTERANCES.filter(
      (item) => item.category === "mid_thought_pause",
    )) {
      const score = scoreSemanticCompleteness(fixture.text);
      expect(score.complete, fixture.id).toBe(false);
      expect(score.label).toBe("incomplete");
    }
  });

  it("labels backchannels as complete turns", () => {
    for (const fixture of SEMANTIC_LABELED_UTTERANCES.filter((item) => item.category === "backchannel")) {
      const score = scoreSemanticCompleteness(fixture.text);
      expect(score.complete, fixture.id).toBe(true);
      expect(score.label).toBe("backchannel");
    }
  });
});

describe("fuseEndpointDecision", () => {
  it("releases when Smart Turn and semantics agree on completion", () => {
    const decision = fuseEndpointDecision(
      true,
      scoreSemanticCompleteness("What are your office hours?"),
      fusionConfig,
    );
    expect(decision).toEqual({
      release: true,
      requestFinalize: true,
      finalizeDelayMs: 250,
    });
  });

  it("defers when Smart Turn approves but semantics are incomplete", () => {
    const decision = fuseEndpointDecision(
      true,
      scoreSemanticCompleteness("I need to know"),
      fusionConfig,
    );
    expect(decision).toEqual({
      release: false,
      requestFinalize: false,
      finalizeDelayMs: 250,
      deferReason: "semantic_incomplete",
    });
  });

  it("shortcuts when semantics are complete but Smart Turn is uncertain", () => {
    const decision = fuseEndpointDecision(
      false,
      scoreSemanticCompleteness("What are your office hours?"),
      fusionConfig,
    );
    expect(decision).toEqual({
      release: true,
      requestFinalize: true,
      finalizeDelayMs: 50,
      shortcutReason: "semantic_complete",
    });
  });

  it("waits when both Smart Turn and semantics are incomplete", () => {
    const decision = fuseEndpointDecision(
      false,
      scoreSemanticCompleteness("I need to know"),
      fusionConfig,
    );
    expect(decision).toEqual({
      release: false,
      requestFinalize: false,
      finalizeDelayMs: 2000,
    });
  });

  it("falls back to Smart Turn only when semantic endpointing is disabled", () => {
    const decision = fuseEndpointDecision(
      true,
      scoreSemanticCompleteness("I need to know"),
      { ...fusionConfig, enabled: false },
    );
    expect(decision).toEqual({
      release: true,
      requestFinalize: true,
      finalizeDelayMs: 250,
    });
  });
});

describe("labeled fusion outcomes vs Smart-Turn-only", () => {
  it("releases complete utterances earlier than Smart-Turn-only when acoustics are uncertain", () => {
    const complete = SEMANTIC_LABELED_UTTERANCES.filter((item) => item.category === "complete");
    for (const fixture of complete) {
      const fused = fuseEndpointDecision(false, scoreSemanticCompleteness(fixture.text), fusionConfig);
      const smartTurnOnly = fuseEndpointDecision(
        false,
        scoreSemanticCompleteness(fixture.text),
        { ...fusionConfig, enabled: false },
      );
      expect(fused.release, fixture.id).toBe(true);
      expect(smartTurnOnly.release, fixture.id).toBe(false);
      expect(fused.finalizeDelayMs).toBeLessThan(fusionConfig.incompleteFallbackMs);
    }
  });

  it("defers mid-thought pauses when Smart Turn would have released", () => {
    const midThought = SEMANTIC_LABELED_UTTERANCES.filter((item) => item.category === "mid_thought_pause");
    for (const fixture of midThought) {
      const fused = fuseEndpointDecision(true, scoreSemanticCompleteness(fixture.text), fusionConfig);
      const smartTurnOnly = fuseEndpointDecision(
        true,
        scoreSemanticCompleteness(fixture.text),
        { ...fusionConfig, enabled: false },
      );
      expect(fused.release, fixture.id).toBe(false);
      expect(smartTurnOnly.release, fixture.id).toBe(true);
      expect(fused.deferReason).toBe("semantic_incomplete");
    }
  });
});
