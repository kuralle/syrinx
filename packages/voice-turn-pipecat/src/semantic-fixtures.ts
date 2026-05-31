export interface SemanticLabeledUtterance {
  readonly id: string;
  readonly text: string;
  readonly category: "complete" | "mid_thought_pause" | "backchannel";
}

export const SEMANTIC_LABELED_UTTERANCES: readonly SemanticLabeledUtterance[] = [
  { id: "complete-question", text: "What are your office hours?", category: "complete" },
  { id: "complete-statement", text: "I would like to schedule an appointment.", category: "complete" },
  { id: "complete-imperative", text: "Please send me the enrollment form.", category: "complete" },
  { id: "complete-multi-clause", text: "I applied last week, and I still have not heard back.", category: "complete" },
  { id: "mid-thought-conjunction", text: "I need to know whether the petition is approved and", category: "mid_thought_pause" },
  { id: "mid-thought-prefix", text: "I need to know", category: "mid_thought_pause" },
  { id: "mid-thought-comma", text: "Before I submit the form,", category: "mid_thought_pause" },
  { id: "mid-thought-article", text: "Can you tell me about the", category: "mid_thought_pause" },
  { id: "backchannel-yeah", text: "yeah", category: "backchannel" },
  { id: "backchannel-uh-huh", text: "uh-huh", category: "backchannel" },
  { id: "backchannel-okay", text: "okay", category: "backchannel" },
  { id: "backchannel-thanks", text: "thank you", category: "backchannel" },
];
