// SPDX-License-Identifier: MIT

type SqlStorage = {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
};

function nextModelCall(sql: SqlStorage, key: string): number {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS spike_mock_calls (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    )`,
  );
  const [row] = [...sql.exec("SELECT count FROM spike_mock_calls WHERE key = ?", key)];
  const current = typeof row?.count === "number" ? row.count : 0;
  const next = current + 1;
  sql.exec("INSERT OR REPLACE INTO spike_mock_calls (key, count) VALUES (?, ?)", key, next);
  return next;
}

function toolCallStream(): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({
        type: "response-metadata",
        id: "id-0",
        modelId: "mock",
        timestamp: new Date(0),
      });
      controller.enqueue({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "confirmAction",
        input: '{"action":"deploy"}',
        providerExecuted: false,
      });
      controller.enqueue({
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });
      controller.close();
    },
  });
}

function textStream(): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({
        type: "response-metadata",
        id: "id-1",
        modelId: "mock",
        timestamp: new Date(0),
      });
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({ type: "text-delta", id: "text-1", delta: "Deployed successfully." });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });
      controller.close();
    },
  });
}

export function createSpikeMockModel(sql: SqlStorage, key = "mastra-session") {
  return {
    specificationVersion: "v2" as const,
    provider: "spike-mock",
    modelId: "spike-mock-v1",
    supportedUrls: {},
    doStream: async () => {
      const callCount = nextModelCall(sql, key);
      const stream = callCount === 1 ? toolCallStream() : textStream();
      return {
        stream,
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: "mock" }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    }),
  };
}

export function resetMockModelCalls(sql: SqlStorage, key = "mastra-session"): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS spike_mock_calls (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    )`,
  );
  sql.exec("DELETE FROM spike_mock_calls WHERE key = ?", key);
}
