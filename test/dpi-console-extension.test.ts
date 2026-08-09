/**
 * dpi-console 扩展层接线测试：三层导航（top → category → items）经
 * runConsole 状态机跑通，Enter（pick）命中 gateway 条目时调用 useGateway
 * （同 /dpi-gateway use <id>）；Skills/Extensions 分类进入注册表管理器。
 *
 * 用 mock ctx：ctx.ui.custom 按调用顺序返回队列里的 pick 结果（不真正拉起
 * VimListPicker），pi 只 stub registerCommand/registerProvider 等；config 与
 * credential store 通过临时 HOME 隔离，health 检查在凭证缺失时短路，全程无网络。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgentManifest, saveConfig } from "../src/config.ts";
import { buildGatewayProfile } from "../src/gateway-writer.ts";
import type { ConsoleNavData } from "../src/dpi-console.ts";
import type { VimListResult } from "../src/vim-list-picker.ts";
import dpiConsole from "../extensions/dpi-console.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

let repo = "";
let home = "";

function useTempHome(): void {
  home = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
  delete process.env.HOME;
  process.env.HOME = home;
}

function seedGatewayProfile(): void {
  const profile = buildGatewayProfile({
    id: "ser7-cpa",
    label: "ser7 CPA",
    baseUrl: "http://100.102.192.34:8317/v1",
    credentialRef: "ser7-cpa",
    providerId: "ser7-cpa",
    api: "openai-completions",
    models: [{ id: "deepseek-v4-flash" }],
  });
  expect(profile).not.toBeNull();
  mkdirSync(join(repo, "profiles", "gateways"), { recursive: true });
  writeFileSync(join(repo, "profiles", "gateways", "ser7-cpa.json"), JSON.stringify(profile));
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  repo = "";
  home = "";
});

interface PiMock {
  pi: ExtensionAPI;
  handlers: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
  registerProvider: ReturnType<typeof vi.fn>;
}

function mockPi(): PiMock {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const pi = {
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      handlers.set(name, spec.handler);
    },
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    on: vi.fn(),
    reload: vi.fn(),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, registerProvider: pi.registerProvider };
}

/** mock ctx：custom 按调用顺序返回队列里的 pick 结果（模拟三层导航的逐步选择）；
 * 同时用 builder 构造出 picker 组件以捕获其标题（opts 私有字段运行时可达），
 * 供断言状态机 Esc 后确实切回预期层级。 */
function makeCtx(results: VimListResult<ConsoleNavData>[]): {
  ctx: never;
  notifyCalls: { message: string; type?: string }[];
  titles: string[];
} {
  const notifyCalls: { message: string; type?: string }[] = [];
  const titles: string[] = [];
  const queue = [...results];
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => "",
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifyCalls.push({ message, type });
      },
      confirm: async () => true,
      select: async () => "",
      custom: async (
        build: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown,
      ) => {
        const component = build(
          null,
          { fg: (_color: string, text: string) => text },
          null,
          () => {},
        );
        titles.push((component as { opts?: { title?: string } }).opts?.title ?? "");
        return queue.shift();
      },
    },
  };
  return { ctx: ctx as never, notifyCalls, titles };
}

function topRepoPick(): VimListResult<ConsoleNavData> {
  return {
    action: "pick",
    item: {
      id: "repo:current",
      label: "[repo] bound",
      data: { level: "top", kind: "repo", id: "current", meta: "bound" },
    },
  };
}

function categoryPick(id: string): VimListResult<ConsoleNavData> {
  return {
    action: "pick",
    item: { id, label: id, data: { level: "category", kind: "category", id, meta: "" } },
  };
}

function gatewayPick(id: string): VimListResult<ConsoleNavData> {
  return {
    action: "pick",
    item: {
      id: `gateway:${id}`,
      label: `[gateway] ${id}`,
      data: { level: "items", kind: "gateway", id, meta: "" },
    },
  };
}

function providerPick(id: string): VimListResult<ConsoleNavData> {
  return {
    action: "pick",
    item: {
      id,
      label: `[provider] ${id}`,
      data: { level: "providers", kind: "provider", id, meta: "" },
    },
  };
}

describe("dpi console extension — three-level navigation", () => {
  it("gateway Enter opens provider list; provider Enter opens model list; Esc unwinds level by level", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    seedGatewayProfile();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi");
    expect(handler).toBeDefined();

    const { ctx, titles } = makeCtx([
      topRepoPick(),
      categoryPick("Gateways"),
      gatewayPick("ser7-cpa"), // Enter gateway → 供应商列表
      providerPick("ser7-cpa"), // Enter 供应商 → 模型列表
      { action: "cancel" }, // Esc at models → providers
      { action: "cancel" }, // Esc at providers → gateways
      { action: "cancel" }, // Esc at gateways → category
    ]);
    await handler!("", ctx);
    expect(titles).toEqual([
      "dpi console",
      "dpi — category",
      "dpi — gateways",
      "dpi — ser7-cpa providers",
      "dpi — ser7-cpa/ser7-cpa models",
      "dpi — ser7-cpa providers",
      "dpi — gateways",
      "dpi — category",
    ]);
  });

  it("pick on an unknown gateway notifies the error", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    const { ctx, notifyCalls } = makeCtx([
      topRepoPick(),
      categoryPick("Gateways"),
      gatewayPick("nope"),
    ]);
    await handler("", ctx);
    expect(notifyCalls.some((n) => n.message.includes("Unknown gateway: nope"))).toBe(true);
  });

  it("Esc at the top level quits the console cleanly", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    const { ctx, notifyCalls } = makeCtx([{ action: "cancel" }]);
    await handler("", ctx);
    expect(notifyCalls).toHaveLength(0);
  });

  it("Esc at the category level returns to top; a second Esc at top exits (never stuck)", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    // top 选仓库 → category 按 Esc → top 再按 Esc 退出。捕获每次 custom 的
    // 列表标题证明层级迁移：category 的 Esc 必须回 top（旧行为卡在 category，
    // 下降后永远无法用 Esc 退出控制台）。
    const { ctx, titles } = makeCtx([topRepoPick(), { action: "cancel" }, { action: "cancel" }]);
    await handler("", ctx);
    expect(titles).toEqual(["dpi console", "dpi — category", "dpi console"]);
  });

  it("category Skills pick enters the skills registry manager (toggle writes back the declaration)", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    mkdirSync(join(repo, "skills", "memory"), { recursive: true });
    writeFileSync(
      join(repo, "skills", "memory", "SKILL.md"),
      "---\ndescription: long term memory\n---\n",
    );
    mkdirSync(join(repo, "agents", "coder"), { recursive: true }); // 声明写回目标目录
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    // top → category Skills → registry manager toggle 完成（勾选 memory）
    const { ctx, notifyCalls } = makeCtx([
      topRepoPick(),
      categoryPick("Skills"),
      { action: "pick", checked: ["memory"] },
    ]);
    await handler("", ctx);
    expect(notifyCalls.some((n) => n.message.includes("Saved:"))).toBe(true);
    expect(readAgentManifest(repo, "coder").skills).toContain("memory");
  });
});
