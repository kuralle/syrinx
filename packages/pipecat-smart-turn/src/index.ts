// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 - Pipecat Smart Turn Plugin
//
// Mirrors Pipecat's LocalSmartTurnAnalyzerV3 turn-stop strategy:
// Silero determines candidate speech boundaries, then Smart Turn v3 decides
// whether a pause is an actual completed user turn.
//
// Node / local default: `new PipecatEOSPlugin()` uses LocalSmartTurnV3Predictor
// (onnxruntime-node). Edge hosts must import from `@kuralle-syrinx/pipecat-smart-turn/eos`
// and inject a non-ONNX predictor (e.g. WorkersAiSmartTurnPredictor).

import { PipecatEOSPlugin as PipecatEOSPluginBase } from "./eos-plugin.js";
import { LocalSmartTurnV3Predictor, type SmartTurnPredictor } from "./predictor.js";

/** Node-facing EOS plugin: defaults to the local ONNX Smart Turn predictor. */
export class PipecatEOSPlugin extends PipecatEOSPluginBase {
  constructor(predictor: SmartTurnPredictor = new LocalSmartTurnV3Predictor()) {
    super(predictor);
  }
}

export {
  fuseEndpointDecision,
  latestTranscript,
  scoreSemanticCompleteness,
  type EndpointFusionDecision,
  type SemanticCompletenessLabel,
  type SemanticCompletenessScore,
  type SemanticEndpointFusionConfig,
} from "./semantic-completeness.js";
export { SEMANTIC_LABELED_UTTERANCES, type SemanticLabeledUtterance } from "./semantic-fixtures.js";
export { LocalSmartTurnV3Predictor, type SmartTurnPredictor } from "./predictor.js";
export {
  SmartTurnInteractionPolicy,
  type SmartTurnInteractionPolicyConfig,
} from "./interaction-policy.js";
