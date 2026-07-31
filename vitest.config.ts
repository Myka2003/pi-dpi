import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // 测试里 import 的包类型只做静态依赖，vitest 用 jiti 加载 TS，
      // 类型 import 会被擦除；运行时只用 node 内置模块。
      "@earendil-works/pi-coding-agent": fileURLToPath(
        new URL("./test/stub-types.ts", import.meta.url),
      ),
      typebox: fileURLToPath(new URL("./test/stub-types.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
