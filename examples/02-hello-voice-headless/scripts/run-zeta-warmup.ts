// SPDX-License-Identifier: MIT

import type { PipelineBus } from "@kuralle-syrinx/core";
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";

const ZETA_BASE_URL =
  "https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct/v1";
const MAX_ATTEMPTS = 8;
const INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;

function fakeBus(): PipelineBus {
  return {
    on: () => () => {},
    push: () => {},
  } as unknown as PipelineBus;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeModels(baseUrl: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENAI_API_KEY"]?.trim() ?? "";
  const plugin = new OpenAICompatibleTTSPlugin();
  await plugin.initialize(fakeBus(), {
    base_url: ZETA_BASE_URL,
    model: "zeta",
    ...(apiKey ? { api_key: apiKey } : {}),
  });

  let warm = false;
  let attempts = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts += 1;
    await plugin.prewarm();
    warm = await probeModels(ZETA_BASE_URL, apiKey);
    if (warm) break;
    if (i < MAX_ATTEMPTS - 1) {
      await sleep(INTERVAL_MS);
    }
  }

  console.log(`zeta-warmup: warm=${String(warm)} attempts=${String(attempts)}`);
  await plugin.close();
  process.exit(warm ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});