/**
 * dpi-console：/dpi 统一控制台扩展入口（薄壳）。
 *
 * 三层导航状态机在 src/dpi-console.ts（runConsole）：top（repo 列表）→
 * category（Skills / Extensions / Gateways）→ items（条目列表）。本文件只做
 * 命令注册 + 把 pi 引用注入 runConsole——gateway 条目 pick 时由 src 层复用
 * gateway-manager 的 useGateway 完成真实接线（同 /dpi-gateway use <id>）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDpiCommand } from "../src/command-alias.ts";
import { runConsole } from "../src/dpi-console.ts";

export default function (pi: ExtensionAPI): void {
  registerDpiCommand(pi, "dpi", {
    description: "Unified dpi console: repo → Skills/Extensions/Gateways → items",
    handler: async (_args, ctx) => {
      await runConsole(ctx, { pi });
    },
  });
}
