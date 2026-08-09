/**
 * dpi-console 扩展层 pick 接线测试：Enter（pick）命中 gateway 条目时调用
 * useGateway（同 /dpi-gateway use <id>），skill/ext 条目通知名称+描述。
 *
 * 用 mock ctx：ctx.ui.custom 直接返回指定 pick 结果（不真正拉起 VimListPicker），
 * pi 只 stub registerCommand/registerProvider 等；config 与 credential store
 * 通过临时 HOME 隔离，health 检查在凭证缺失时短路，全程无网络。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.ts";
import { buildGatewayProfile } from "../src/gateway-writer.ts";
import type { ConsoleItemData } from "../src/dpi-console.ts";
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

function makeCtx(result: VimListResult<ConsoleItemData>): {
  ctx: never;
  notifyCalls: { message: string; type?: string }[];
} {
  const notifyCalls: { message: string; type?: string }[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => "",
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifyCalls.push({ message, type });
      },
      confirm: async () => true,
      select: async () => "",
      custom: async () => result,
    },
  };
  return { ctx: ctx as never, notifyCalls };
}

function pickItem(kind: ConsoleItemData["kind"], id: string, meta = ""): VimListResult<ConsoleItemData> {
  return {
    action: "pick",
    item: { id: `${kind}:${id}`, label: `[${kind}] ${id}`, data: { kind, id, meta } },
  };
}

describe("dpi console extension — pick wiring", () => {
  it("pick on a gateway runs useGateway (health report, not the src placeholder)", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    seedGatewayProfile();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers, registerProvider } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi");
    expect(handler).toBeDefined();

    const { ctx, notifyCalls } = makeCtx(pickItem("gateway", "ser7-cpa"));
    await handler!("", ctx);
    // useGateway 的 health 失败路径（临时 HOME 无凭证 → credential: missing，不发网络请求）
    expect(notifyCalls.some((n) => n.message.includes("credential: missing"))).toBe(true);
    expect(notifyCalls.some((n) => n.message.includes("wire to applyProfile"))).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("pick on an unknown gateway notifies the error", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    const { ctx, notifyCalls } = makeCtx(pickItem("gateway", "nope"));
    await handler("", ctx);
    expect(notifyCalls.some((n) => n.message.includes("Unknown gateway: nope"))).toBe(true);
  });

  it("pick on a skill notifies name + description from the item meta", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    const { ctx, notifyCalls } = makeCtx(pickItem("skill", "memory", "long term memory"));
    await handler("", ctx);
    const msg = notifyCalls.at(-1)?.message ?? "";
    expect(msg).toContain("memory");
    expect(msg).toContain("long term memory");
  });

  it("pick on an ext notifies name + description from the item meta", async () => {
    useTempHome();
    repo = mkdtempSync(join(tmpdir(), "dpi-console-ext-"));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: repo });
    const { pi, handlers } = mockPi();
    dpiConsole(pi);
    const handler = handlers.get("dpi")!;

    const { ctx, notifyCalls } = makeCtx(pickItem("ext", "spotify", "play music from the terminal"));
    await handler("", ctx);
    const msg = notifyCalls.at(-1)?.message ?? "";
    expect(msg).toContain("spotify");
    expect(msg).toContain("play music from the terminal");
  });
});
