export type SemanticCompletenessLabel = "complete" | "incomplete" | "backchannel";

export interface SemanticCompletenessScore {
  readonly complete: boolean;
  readonly label: SemanticCompletenessLabel;
  readonly confidence: number;
}

export interface SemanticEndpointFusionConfig {
  readonly enabled: boolean;
  readonly finalizeDelayMs: number;
  readonly semanticShortcutDelayMs: number;
  readonly incompleteFallbackMs: number;
}

export interface EndpointFusionDecision {
  readonly release: boolean;
  readonly requestFinalize: boolean;
  readonly finalizeDelayMs: number;
  readonly deferReason?: "semantic_incomplete";
  readonly shortcutReason?: "semantic_complete";
}

const TRAILING_INCOMPLETE =
  /\b(and|but|or|so|because|if|when|while|although|though|since|unless|until|as|that|which|who|where|how|what|why|the|a|an|to|for|of|in|on|at|with|about|from|by|into|through|after|before|during|without|within|between|among|over|under|around|against|toward|towards|upon|like|than|not|please|just|also|then|well|um|uh|er|hmm|i|we|you|he|she|they|my|your|our|their|this|these|those)\s*$/i;

const EXACT_INCOMPLETE = [
  /^i need to know$/i,
  /^i want to know$/i,
  /^can you tell me$/i,
  /^how do i$/i,
  /^what is the$/i,
];

const INCOMPLETE_PREFIXES: readonly RegExp[] = [
  /^i need to\b/i,
  /^i want to\b/i,
  /^can you tell me about\b/i,
  /^what is the\b/i,
  /^how do i\b/i,
  /^i'm trying to\b/i,
  /^i am trying to\b/i,
  /^could you help me with\b/i,
  /^tell me about the\b/i,
];

const OPEN_ENDED_PREFIXES: readonly RegExp[] = [
  /^i was wondering if\b/i,
];

const BACKCHANNEL =
  /^(yeah|yes|yep|yup|uh-?huh|mm-?hmm|mhm|right|okay|ok|sure|got it|thank you|thanks|no|nope|nah)\.?$/i;

const SENTENCE_END = /[.!?]["')]*\s*$/;

export function scoreSemanticCompleteness(text: string): SemanticCompletenessScore {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { complete: false, label: "incomplete", confidence: 0 };
  }

  if (BACKCHANNEL.test(normalized)) {
    return { complete: true, label: "backchannel", confidence: 0.95 };
  }

  if (SENTENCE_END.test(normalized)) {
    return { complete: true, label: "complete", confidence: 0.9 };
  }

  if (TRAILING_INCOMPLETE.test(normalized)) {
    return { complete: false, label: "incomplete", confidence: 0.85 };
  }

  for (const phrase of EXACT_INCOMPLETE) {
    if (phrase.test(normalized)) {
      return { complete: false, label: "incomplete", confidence: 0.85 };
    }
  }

  for (const prefix of INCOMPLETE_PREFIXES) {
    if (!prefix.test(normalized)) continue;
    const remainder = normalized.replace(prefix, "").trim();
    if (!remainder) {
      return { complete: false, label: "incomplete", confidence: 0.8 };
    }
  }

  for (const prefix of OPEN_ENDED_PREFIXES) {
    if (prefix.test(normalized)) {
      return { complete: false, label: "incomplete", confidence: 0.75 };
    }
  }

  if (/,\s*$/.test(normalized)) {
    return { complete: false, label: "incomplete", confidence: 0.75 };
  }

  const words = normalized.split(/\s+/);
  if (
    /^(what|where|when|why|how|who|which|is|are|do|does|did|can|could|would|will|should|have|has|had)\b/i.test(
      normalized,
    ) &&
    words.length >= 4
  ) {
    return { complete: true, label: "complete", confidence: 0.7 };
  }

  return { complete: true, label: "complete", confidence: 0.55 };
}

export function fuseEndpointDecision(
  smartTurnComplete: boolean,
  semantic: SemanticCompletenessScore,
  config: SemanticEndpointFusionConfig,
): EndpointFusionDecision {
  if (!config.enabled) {
    return {
      release: smartTurnComplete,
      requestFinalize: smartTurnComplete,
      finalizeDelayMs: config.finalizeDelayMs,
    };
  }

  if (smartTurnComplete && semantic.complete) {
    return {
      release: true,
      requestFinalize: true,
      finalizeDelayMs: config.finalizeDelayMs,
    };
  }

  if (smartTurnComplete && !semantic.complete) {
    return {
      release: false,
      requestFinalize: false,
      finalizeDelayMs: config.finalizeDelayMs,
      deferReason: "semantic_incomplete",
    };
  }

  if (!smartTurnComplete && semantic.complete && semantic.confidence >= 0.85 && config.semanticShortcutDelayMs > 0) {
    return {
      release: true,
      requestFinalize: true,
      finalizeDelayMs: config.semanticShortcutDelayMs,
      shortcutReason: "semantic_complete",
    };
  }

  return {
    release: false,
    requestFinalize: false,
    finalizeDelayMs: config.incompleteFallbackMs,
  };
}

export function latestTranscript(finalSegments: readonly string[], interimText: string): string {
  const finals = finalSegments.join(" ").replace(/\s+/g, " ").trim();
  const interim = interimText.trim();
  if (!interim) return finals;
  if (!finals) return interim;
  if (interim.startsWith(finals) || finals.startsWith(interim)) {
    return interim.length >= finals.length ? interim : finals;
  }
  return `${finals} ${interim}`.replace(/\s+/g, " ").trim();
}
