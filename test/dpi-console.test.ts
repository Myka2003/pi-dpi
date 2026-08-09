/**
 * dpi-console 测试：四类条目构建（repo/gateway/skill/ext）+ 按键路由
 * （add/delete/status/pick）+ add-gateway 严格流程与回滚。
 *
 * 约定：HOME 指到临时目录隔离 config 与 credential store；add-gateway 的
 * 网络调用通过 vi.stubGlobal("fetch") 注入 mock，保证测试免网络。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.ts";
import { readCredential, writeCredential } from "../src/credential-store.ts";
import { buildConsoleItems, handleConsoleResult } from "../src/dpi-console.ts";
import { scanGatewayProfiles } from "../src/gateway-profile.ts";
import { buildGatewayProfile } from "../src/gateway-writer.ts";
import { bindRepoWithKey } from "../src/repo-binder.ts";
import type { ConsoleItemData } from "../src/dpi-console.ts";
import type { VimListItem, VimListResult } from "../src/vim-list-picker.ts";

// addRepoFlow 委托给 bindRepoWithKey（写 key/config + clone）；mock 掉真实克隆，
// 保持测试离线确定性（bindRepoWithKey 自身的落地逻辑在 repo-binder.test.ts 覆盖）
vi.mock("../src/repo-binder.ts", () => ({
  bindRepoWithKey: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(bindRepoWithKey).mockReset();
});

let repo = "";
let home = "";

function makeRepo(): string {
  repo = mkdtempSync(join(tmpdir(), "dpi-console-"));
  return repo;
}

function useTempHome(): void {
  home = mkdtempSync(join(tmpdir(), "dpi-console-home-"));
  delete process.env.HOME;
  process.env.HOME = home;
}

/** 在 repo 里铺一份 gateway profile + skill + extension，返回 seed 信息 */
function seedRepo(): void {
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
  mkdirSync(join(repo, "skills", "memory"), { recursive: true });
  writeFileSync(join(repo, "skills", "memory", "SKILL.md"), "---\ndescription: long term memory\n---\n");
  mkdirSync(join(repo, "extensions"), { recursive: true });
  writeFileSync(join(repo, "extensions", "spotify.ts"), "export default () => {};\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  repo = "";
  home = "";
});

interface UiState {
  notifyCalls: { message: string; type?: string }[];
  inputQueue: string[];
}

/** 最小 ctx stub：input 按队列吐值，notify 记录调用 */
function makeCtx(): { ctx: never; state: UiState } {
  const state: UiState = { notifyCalls: [], inputQueue: [] };
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => state.inputQueue.shift() ?? "",
      notify: (message: string, type?: "info" | "warning" | "error") => {
        state.notifyCalls.push({ message, type });
      },
      confirm: async () => true,
      select: async () => "",
      custom: async () => undefined,
    },
  };
  return { ctx: ctx as never, state };
}

function gatewayItem(id: string): VimListItem<ConsoleItemData> {
  return { id: `gateway:${id}`, label: `[gateway] ${id}`, data: { kind: "gateway", id, meta: "" } };
}

function repoItem(): VimListItem<ConsoleItemData> {
  return { id: "repo:current", label: "[repo] bound", data: { kind: "repo", id: "current", meta: "bound" } };
}

function skillItem(name: string): VimListItem<ConsoleItemData> {
  return { id: `skill:${name}`, label: `[skill] ${name}`, data: { kind: "skill", id: name, meta: "" } };
}

/** mock fetch：默认返回 /models 空目录；传 error 则抛 */
function mockFetch(payload: { data: { id: string }[] }, error?: Error): typeof fetch {
  return (async () => {
    if (error) throw error;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("dpi console — buildConsoleItems", () => {
  it("builds items for all four kinds", () => {
    const repoPath = makeRepo();
    seedRepo();
    const items = buildConsoleItems({
      repoPath,
      repoUrl: "https://github.com/Myka2003/Agent.git",
      currentGateway: "ser7-cpa",
    });
    expect(items.some((i) => i.data.kind === "repo")).toBe(true);
    expect(items.some((i) => i.data.kind === "gateway")).toBe(true);
    expect(items.some((i) => i.data.kind === "skill")).toBe(true);
    expect(items.some((i) => i.data.kind === "ext")).toBe(true);
  });

  it("marks the current gateway as selected", () => {
    const repoPath = makeRepo();
    seedRepo();
    const items = buildConsoleItems({ repoPath, repoUrl: "", currentGateway: "ser7-cpa" });
    const gateway = items.find((i) => i.data.kind === "gateway");
    expect(gateway?.meta).toContain("selected");
    expect(items.some((i) => i.data.kind === "repo")).toBe(false); // 未绑定 repo 不出现 repo 条目
  });

  it("returns only the repo item for an empty repo", () => {
    const repoPath = makeRepo();
    const items = buildConsoleItems({
      repoPath,
      repoUrl: "https://github.com/Myka2003/Agent.git",
      currentGateway: "",
    });
    expect(items).toHaveLength(1);
    expect(items[0].data.kind).toBe("repo");
  });
});

describe("dpi console — addGatewayFlow", () => {
  it("warns when no content repo is bound", async () => {
    useTempHome();
    const { ctx, state } = makeCtx();
    await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });
    expect(state.notifyCalls[0]?.message).toContain("No content repo bound");
  });

  it("rejects an invalid gateway id", async () => {
    useTempHome();
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["Bad ID"];
    await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });
    expect(state.notifyCalls.some((n) => n.message.includes("Invalid gateway id"))).toBe(true);
  });

  it("requires baseUrl and API key", async () => {
    useTempHome();
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["ok-gw", "label", "https://gw.example.com/v1", ""];
    await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });
    expect(state.notifyCalls.some((n) => n.message === "baseUrl and API key are required")).toBe(true);
    expect(readCredential("ok-gw")).toBeNull();
  });

  it("happy path: credential + profile written, then commit attempted", async () => {
    useTempHome();
    vi.stubGlobal(
      "fetch",
      mockFetch({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }),
    );
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["my-gw", "My Gateway", "https://gw.example.com/v1", "sk-secret-abc"];
    const next = await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });

    expect(next).toBe("reopen");
    // key 只进 credential store（0600），不出现于任何 notify
    expect(readCredential("my-gw")).toBe("sk-secret-abc");
    expect(
      state.notifyCalls.every((n) => !n.message.includes("sk-secret-abc")),
    ).toBe(true);
    // profile 落库
    const profiles = scanGatewayProfiles(repoPath);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("my-gw");
    expect(profiles[0].providers[0].models.map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    // 非 git 临时目录：commit 失败 → 失败提示里仍带上 id 与 commit=false
    const last = state.notifyCalls.at(-1)!;
    expect(last.message).toContain("Gateway my-gw added");
    expect(last.message).toContain("commit=false");
  });

  it("rolls back the credential when the model scan fails", async () => {
    useTempHome();
    vi.stubGlobal("fetch", mockFetch({ data: [] }, new Error("boom")));
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["bad-gw", "Bad", "https://gw.example.com/v1", "sk-x"];
    const next = await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });

    expect(next).toBe("reopen");
    expect(readCredential("bad-gw")).toBeNull(); // 回滚：credential 已删
    expect(scanGatewayProfiles(repoPath)).toHaveLength(0); // 无半成品 profile
    expect(state.notifyCalls.some((n) => n.message.startsWith("Model scan failed:"))).toBe(true);
  });

  it("rolls back the credential when the profile fails validation", async () => {
    useTempHome();
    vi.stubGlobal("fetch", mockFetch({ data: [{ id: "m1" }] }));
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    // baseUrl 缺 /v1 路径 → buildGatewayProfile 校验失败
    state.inputQueue = ["gw2", "gw2", "https://gw.example.com", "sk"];
    await handleConsoleResult(ctx, { action: "add", item: gatewayItem("ser7-cpa") });

    expect(readCredential("gw2")).toBeNull();
    expect(state.notifyCalls.some((n) => n.message.includes("Profile failed validation"))).toBe(true);
  });
});

describe("dpi console — handleConsoleResult routing", () => {
  it("routes add on a repo item to addRepoFlow → bindRepoWithKey, notifying the error", async () => {
    useTempHome();
    vi.mocked(bindRepoWithKey).mockResolvedValue({ ok: false, error: "clone failed: boom" });
    const { ctx, state } = makeCtx();
    state.inputQueue = [
      "https://github.com/Myka2003/Agent.git",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    ];
    const next = await handleConsoleResult(ctx, { action: "add", item: repoItem() });

    expect(next).toBe("reopen");
    // addRepoFlow 直接委托 binder，不再暂存 repo-<ts> credential
    expect(bindRepoWithKey).toHaveBeenCalledWith(
      "https://github.com/Myka2003/Agent.git",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    );
    expect(state.notifyCalls.at(-1)?.message).toContain("clone failed: boom");
  });

  it("notifies success when the repo binds", async () => {
    useTempHome();
    vi.mocked(bindRepoWithKey).mockResolvedValue({ ok: true });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["https://github.com/Myka2003/Agent.git", "PRIVATE KEY MATERIAL"];
    const next = await handleConsoleResult(ctx, { action: "add", item: repoItem() });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.at(-1)?.message).toContain("Repo bound");
  });

  it("empty-list add with no bound repo runs addRepoFlow", async () => {
    useTempHome();
    vi.mocked(bindRepoWithKey).mockResolvedValue({ ok: true });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["https://github.com/Myka2003/Agent.git", "key-material"];
    const next = await handleConsoleResult(ctx, { action: "add" });
    expect(next).toBe("reopen");
    expect(bindRepoWithKey).toHaveBeenCalledTimes(1);
  });

  it("empty-list add with a bound repo notifies and quits (no infinite reopen)", async () => {
    useTempHome();
    const repoPath = makeRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleConsoleResult(ctx, { action: "add" });
    expect(next).toBe("done");
    expect(state.notifyCalls.some((n) => n.message.includes("Nothing to add"))).toBe(true);
  });

  it("rejects a non-GitHub repo URL", async () => {
    useTempHome();
    const { ctx, state } = makeCtx();
    state.inputQueue = ["https://example.com/owner/repo", ""];
    await handleConsoleResult(ctx, { action: "add", item: repoItem() });
    expect(
      state.notifyCalls.some((n) => n.message.includes("Expected https://github.com/owner/repo")),
    ).toBe(true);
  });

  it("routes add on a skill item through the skill registry manager", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx } = makeCtx();
    const next = await handleConsoleResult(ctx, { action: "add", item: skillItem("memory") });
    expect(next).toBe("reopen");
  });

  it("delete on a gateway removes the profile and reopens", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx } = makeCtx();
    const next = await handleConsoleResult(ctx, {
      action: "delete",
      item: gatewayItem("ser7-cpa"),
    });

    expect(next).toBe("reopen");
    expect(existsSync(join(repoPath, "profiles", "gateways", "ser7-cpa.json"))).toBe(false);
  });

  it("delete on a repo item clears the dpi-agent-repo-key credential and keeps the binding", async () => {
    useTempHome();
    writeCredential("dpi-agent-repo-key", "k");
    const { ctx, state } = makeCtx();
    const next = await handleConsoleResult(ctx, { action: "delete", item: repoItem() });
    expect(next).toBe("reopen");
    expect(readCredential("dpi-agent-repo-key")).toBeNull(); // 删的是 binder 的凭证引用，不是 "current"
    expect(state.notifyCalls.some((n) => n.message.includes("Repo binding kept"))).toBe(true);
  });

  it("status on a gateway reports credential resolution (health check)", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleConsoleResult(ctx, {
      action: "status",
      item: gatewayItem("ser7-cpa"),
    });

    expect(next).toBe("done");
    const report = state.notifyCalls.at(-1)!;
    expect(report.message).toContain("Gateway: ser7-cpa");
    expect(report.message).toContain("credential: missing"); // 临时 HOME 无凭证 → 不发网络请求
  });

  it("pick on a gateway notifies use", async () => {
    const { ctx, state } = makeCtx();
    const next = await handleConsoleResult(ctx, { action: "pick", item: gatewayItem("ser7-cpa") });
    expect(next).toBe("done");
    expect(state.notifyCalls.some((n) => n.message.includes("use gateway: ser7-cpa"))).toBe(true);
  });

  it("pick with no item (empty list) quits", async () => {
    const { ctx } = makeCtx();
    const next = await handleConsoleResult(ctx, { action: "pick" });
    expect(next).toBe("done");
  });
});
