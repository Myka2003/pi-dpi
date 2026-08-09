/**
 * dpi-console：/dpi 统一控制台扩展入口（薄壳）。
 *
 * 列表构建与按键路由在 src/dpi-console.ts（纯逻辑，可单测）；本文件只做
 * 命令注册 + VimListPicker 主循环。skill/ext 条目的增删在 src 层复用
 * runRegistryManager（与 /dpi-skills、/dpi-extensions 同构），每次操作后
 * 重开列表以反映注册表变化。
 *
 * pick（Enter）：gateway → useGateway（同 /dpi-gateway use <id>）；
 * skill/ext → 通知名称 + 描述（来自条目 meta）；repo → 交给 src 层 status 提示。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDpiCommand } from "../src/command-alias.ts";
import { loadConfig } from "../src/config.ts";
import {
  buildConsoleItems,
  handleConsoleResult,
  type ConsoleItemData,
} from "../src/dpi-console.ts";
import { showVimListPicker } from "../src/vim-list-picker.ts";
import { useGateway } from "./gateway-manager.ts";

export default function (pi: ExtensionAPI): void {
  registerDpiCommand(pi, "dpi", {
    description: "Unified dpi console: gateways, repo, skills, extensions",
    handler: async (_args, ctx) => {
      for (;;) {
        const cfg = loadConfig();
        const items = buildConsoleItems({
          repoPath: cfg.repoPath,
          repoUrl: cfg.repoUrl,
          currentGateway: cfg.currentGateway,
          currentAgent: cfg.currentAgent,
        });
        if (!ctx.hasUI) {
          ctx.ui.notify(items.map((i) => i.label).join("\n") || "No items", "info");
          return;
        }
        const result = await showVimListPicker<ConsoleItemData>(ctx, {
          title: "dpi console",
          items,
          mode: "select",
          actions: [
            { key: "a", id: "add", hint: "add" },
            { key: "d", id: "delete", hint: "delete" },
            { key: "s", id: "status", hint: "status" },
          ],
          hint: "j/k nav · / filter · Enter select · a add · d delete · s status · Esc quit",
        });
        if (!result || result.action === "cancel") return;
        // pick（Enter）：gateway → useGateway；skill/ext → 名称+描述；repo → src 层 status 提示
        if (result.action === "pick" && result.item) {
          const item = result.item.data;
          if (item.kind === "gateway") {
            await useGateway(pi, item.id, ctx);
            return;
          }
          if (item.kind === "skill" || item.kind === "ext") {
            ctx.ui.notify(
              item.meta ? `${item.kind}: ${item.id} — ${item.meta}` : `${item.kind}: ${item.id}`,
              "info",
            );
            return;
          }
          // repo pick 落到 handleConsoleResult（status 摘要）
        }
        const next = await handleConsoleResult(ctx, result);
        if (next === "done") return;
      }
    },
  });
}
