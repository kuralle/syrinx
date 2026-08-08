import { defineConfig, mergeConfig } from "vitest/config";

import socketConfig from "../../vitest.socket.config.js";

export default mergeConfig(
  socketConfig,
  defineConfig({
    test: {
      fileParallelism: false,
    },
  }),
);
