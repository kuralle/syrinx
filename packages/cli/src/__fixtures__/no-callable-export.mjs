// SPDX-License-Identifier: MIT
//
// Test-only module with no callable export at all — resolveAgentFactory must
// refuse and name what it did find.

export const notAFunction = 42;
export const alsoNotCallable = "nope";
