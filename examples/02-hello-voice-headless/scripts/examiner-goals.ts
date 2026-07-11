// SPDX-License-Identifier: MIT
//
// Staged goal scripts for the live full-duplex examiner.
// Each Daily task has ordered sub-goals the LLM examiner advances through.

export interface SubGoal {
  readonly description: string;
}

export interface DailyTask {
  readonly name: string;
  readonly scenario: string;
  readonly subGoals: readonly SubGoal[];
}

export const BOOK_ADVISING_APPOINTMENT: DailyTask = {
  name: "book-advising-appointment",
  scenario:
    "You are a student calling Syrinx University Student Relations to book an academic advising appointment. You are Maya Chen (student ID S10042), a Biology major. You need to meet with your advisor Dr. Priya Raman before the late add deadline.",
  subGoals: [
    { description: "Identify yourself as Maya Chen and ask to book an advising appointment." },
    { description: "Confirm you need to meet before the late add deadline for Biology 101." },
    { description: "Accept the offered appointment time or ask for availability." },
    { description: "Confirm the appointment and ask about any forms needed." },
  ],
};

export const CHECK_FINANCIAL_AID: DailyTask = {
  name: "check-financial-aid",
  scenario:
    "You are a student calling Syrinx University Student Relations to check your financial aid status. You are Maya Chen (student ID S10042) and you're worried about maintaining full-time status.",
  subGoals: [
    { description: "Identify yourself and ask about financial aid status." },
    { description: "Confirm your full-time enrollment status." },
    { description: "Ask about any pending deadlines or reviews." },
  ],
};

export const DAILY_TASKS: Record<string, DailyTask> = {
  [BOOK_ADVISING_APPOINTMENT.name]: BOOK_ADVISING_APPOINTMENT,
  [CHECK_FINANCIAL_AID.name]: CHECK_FINANCIAL_AID,
};

export function resolveDailyTask(name: string): DailyTask {
  const task = DAILY_TASKS[name];
  if (!task) throw new Error(`unknown daily task: ${name} (available: ${Object.keys(DAILY_TASKS).join(", ")})`);
  return task;
}
