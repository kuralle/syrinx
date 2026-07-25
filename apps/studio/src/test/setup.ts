import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// Testing Library only auto-cleans when it detects a global `afterEach`, which
// vitest does not expose unless `globals: true`. Without this every render
// accumulates in the DOM, so any `getBy*` in a file with more than one test
// fails with "Found multiple elements" — a failure that reads like a component
// bug but is a harness gap.
afterEach(() => {
  cleanup();
});
