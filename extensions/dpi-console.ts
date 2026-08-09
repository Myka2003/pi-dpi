/**
 * dpi-console：/dpi 统一控制台扩展入口（薄壳）。
 *
 * 内容模型驱动导航状态机在 src/dpi-console.ts（runConsole）：top（repo 列表）→
 * category（Agents / Skills / Extensions / Gateways / Sessions / Machines）→
 * 各分类条目列表；Gateways 深入两级：gateway 列表 → 供应商列表 → 模型列表
 * （增删全部 commit+push）。本文件只做命令注册 + 把 pi 引用注入 runConsole。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDpiCommand } from "../src/command-alias.ts";
import { runConsole } from "../src/dpi-console.ts";

export default function (pi: ExtensionAPI): void {
  registerDpiCommand(pi, "dpi", {
    description: "Unified dpi console: repo → categories → items (gateways: providers/models)",
    handler: async (_args, ctx) => {
      await runConsole(ctx, { pi });
    },
  });
}
