/**
 * dpi-console 测试：四类条目构建（repo/gateway/skill/ext）+ 按键路由
 * （add/delete/status/pick）+ add-gateway 严格流程与回滚。
 *
 * 约定：HOME 指到临时目录隔离 config 与 credential store；add-gateway 的
 * 网络调用通过 vi.stubGlobal("fetch") 注入 mock，保证测试免网络。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import { readCredential, writeCredential } from "../src/credential-store.ts";
import {
  buildConsoleItems,
  buildTopItems,
  buildCategoryItems,
  buildItemList,
  buildProviderList,
  buildModelList,
  buildAgentList,
  buildMachineList,
  formatSessionsStatus,
  handleConsoleResult,
  handleTopResult,
  handleCategoryResult,
  handleItemResult,
  handleGatewayListResult,
  handleProviderListResult,
  handleModelListResult,
  handleAgentListResult,
  handleMachineListResult,
} from "../src/dpi-console.ts";
import { scanGatewayProfiles } from "../src/gateway-profile.ts";
import { addProviderToGateway, buildGatewayProfile, commitPushGateway, writeGatewayProfile } from "../src/gateway-writer.ts";
import { bindRepoWithKey } from "../src/repo-binder.ts";
import { runSessionBrowser } from "../extensions/session-browser.ts";
import type { ConsoleItemData, ConsoleNavData } from "../src/dpi-console.ts";
import type { VimListItem, VimListResult } from "../src/vim-list-picker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// addRepoFlow 委托给 bindRepoWithKey（写 key/config + clone）；mock 掉真实克隆，
// 保持测试离线确定性（bindRepoWithKey 自身的落地逻辑在 repo-binder.test.ts 覆盖）
vi.mock("../src/repo-binder.ts", () => ({
  bindRepoWithKey: vi.fn(),
}));

// Sessions 分类委托 runSessionBrowser（真实实现依赖 pi 扩展环境）；mock 掉以断言
// 前缀传参，runSessionBrowser 自身逻辑由 session-browser 覆盖
vi.mock("../extensions/session-browser.ts", () => ({
  runSessionBrowser: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(bindRepoWithKey).mockReset();
  vi.mocked(runSessionBrowser).mockReset();
});

let repo = "";
let home = "";
let bare = "";

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
  vi.unstubAllEnvs();
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (bare) rmSync(bare, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  repo = "";
  bare = "";
  home = "";
});

interface UiState {
  notifyCalls: { message: string; type?: string }[];
  inputQueue: string[];
}

/** 真实 git 仓库（本地 bare 远端）：供应商/模型增删的 commit+push 全链路可用 */
function makeGitRepo(): { work: string; bare: string } {
  const work = mkdtempSync(join(tmpdir(), "dpi-console-git-work-"));
  const barePath = mkdtempSync(join(tmpdir(), "dpi-console-git-bare-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: work });
  execFileSync("git", ["init", "--bare", "-b", "main", barePath]);
  execFileSync("git", ["remote", "add", "origin", barePath], { cwd: work });
  execFileSync(
    "git",
    ["-C", work, "-c", "user.name=dpi", "-c", "user.email=dpi@users.noreply.github.com", "commit", "--allow-empty", "-m", "init"],
  );
  execFileSync("git", ["-C", work, "push", "-u", "origin", "main"]);
  mkdirSync(join(work, "profiles", "gateways"), { recursive: true });
  return { work, bare: barePath };
}

/** 在真实 git 仓库里铺一个 gateway 并 commit+push，返回 work 路径 */
async function seedGitGateway(): Promise<string> {
  const git = makeGitRepo();
  repo = git.work;
  bare = git.bare;
  const profile = buildGatewayProfile({
    id: "ser7-cpa",
    label: "ser7 CPA",
    baseUrl: "http://100.102.192.34:8317/v1",
    credentialRef: "ser7-cpa",
    providerId: "ser7-cpa",
    api: "openai-completions",
    models: [{ id: "deepseek-v4-flash" }],
  })!;
  writeGatewayProfile(git.work, profile);
  const added = await commitPushGateway(git.work, "ser7-cpa", "feat: add gateway");
  expect(added.committed).toBe(true);
  expect(added.pushed).toBe(true);
  return git.work;
}

/**
 * 最小 ctx stub：input 按队列吐值，notify 记录调用，custom 按队列吐
 * VimListResult（供应商/模型 toggle 选择器用；空队列返回 undefined）。
 */
function makeCtx(customQueue: VimListResult<never>[] = []): { ctx: never; state: UiState } {
  const state: UiState = { notifyCalls: [], inputQueue: [] };
  const queue = [...customQueue];
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => state.inputQueue.shift() ?? "",
      notify: (message: string, type?: "info" | "warning" | "error") => {
        state.notifyCalls.push({ message, type });
      },
      confirm: async () => true,
      select: async () => "",
      custom: async () => queue.shift(),
    },
    reload: async () => {},
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

describe("three-level navigation", () => {
  it("top level lists repo + add entry, both at level top", () => {
    const items = buildTopItems({
      repoUrl: "https://github.com/Myka2003/Agent.git",
      repoPath: "/tmp/x",
    });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].data.level).toBe("top");
    expect(items[0].data.kind).toBe("repo");
    expect(items.some((i) => i.data.id === "add" && i.data.kind === "repo")).toBe(true);
  });

  it("top level has only the add entry when no repo is bound", () => {
    const items = buildTopItems({ repoUrl: "", repoPath: "/tmp/x" });
    expect(items).toHaveLength(1);
    expect(items[0].data.id).toBe("add");
  });

  it("category level lists the six fixed categories", () => {
    const items = buildCategoryItems();
    const kinds = items.map((i) => i.data.id);
    expect(kinds).toEqual(["Agents", "Skills", "Extensions", "Gateways", "Sessions", "Machines"]);
    for (const item of items) {
      expect(item.data.level).toBe("category");
      expect(item.data.kind).toBe("category");
    }
  });

  it("handleTopResult pick on the bound repo enters category; Esc returns done", async () => {
    const { ctx } = makeCtx();
    const enter = await handleTopResult(ctx, {
      action: "pick",
      item: { id: "repo:0", label: "r", data: { level: "top", kind: "repo", id: "0", meta: "" } },
    });
    expect(enter).toBe("enter");
    const esc = await handleTopResult(ctx, { action: "cancel" });
    expect(esc).toBe("done");
  });

  it("handleTopResult pick on the add entry runs addRepoFlow and reopens", async () => {
    useTempHome();
    vi.mocked(bindRepoWithKey).mockResolvedValue({ ok: true });
    const { ctx, state } = makeCtx();
    state.inputQueue = ["https://github.com/Myka2003/Agent.git", "key-material"];
    const next = await handleTopResult(ctx, {
      action: "pick",
      item: { id: "repo:add", label: "+ Add repo", data: { level: "top", kind: "repo", id: "add", meta: "" } },
    });
    expect(next).toBe("reopen");
    expect(bindRepoWithKey).toHaveBeenCalledTimes(1);
    expect(state.notifyCalls.at(-1)?.message).toContain("Repo bound");
  });

  it("handleTopResult status reports repo health via inspectRepo", async () => {
    useTempHome();
    const { ctx, state } = makeCtx();
    const next = await handleTopResult(ctx, { action: "status" });
    expect(next).toBe("reopen");
    const msg = state.notifyCalls.at(-1)?.message ?? "";
    expect(msg).toContain("repoUrl missing");
  });

  it("handleCategoryResult Skills/Extensions run the registry manager; Agents/Gateways/Machines enter their lists", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx } = makeCtx();
    const skills = await handleCategoryResult(ctx, {
      action: "pick",
      item: { id: "Skills", label: "Skills", data: { level: "category", kind: "category", id: "Skills", meta: "" } },
    });
    expect(skills).toBe("back");
    const ext = await handleCategoryResult(ctx, {
      action: "pick",
      item: { id: "Extensions", label: "Extensions", data: { level: "category", kind: "category", id: "Extensions", meta: "" } },
    });
    expect(ext).toBe("back");
    const gateways = await handleCategoryResult(ctx, {
      action: "pick",
      item: { id: "Gateways", label: "Gateways", data: { level: "category", kind: "category", id: "Gateways", meta: "" } },
    });
    expect(gateways).toBe("gateways");
    const agents = await handleCategoryResult(ctx, {
      action: "pick",
      item: { id: "Agents", label: "Agents", data: { level: "category", kind: "category", id: "Agents", meta: "" } },
    });
    expect(agents).toBe("agents");
    const machines = await handleCategoryResult(ctx, {
      action: "pick",
      item: { id: "Machines", label: "Machines", data: { level: "category", kind: "category", id: "Machines", meta: "" } },
    });
    expect(machines).toBe("machines");
    const esc = await handleCategoryResult(ctx, { action: "cancel" });
    expect(esc).toBe("back");
  });

  it("buildItemList lists gateway entries at the items level", () => {
    const repoPath = makeRepo();
    seedRepo();
    const items = buildItemList({ repoPath, currentGateway: "ser7-cpa" }, "gateway");
    const gateway = items.find((i) => i.data.id === "ser7-cpa");
    expect(gateway).toBeDefined();
    expect(gateway!.data.level).toBe("items");
    expect(gateway!.data.kind).toBe("gateway");
    expect(gateway!.meta).toContain("selected");
  });

  it("handleItemResult gateway pick uses useGateway (health failure in temp HOME)", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const stubPi = { registerProvider: vi.fn(), unregisterProvider: vi.fn() } as unknown as ExtensionAPI;
    const next = await handleItemResult(
      ctx,
      {
        action: "pick",
        item: {
          id: "gateway:ser7-cpa",
          label: "[gateway] ser7-cpa",
          data: { level: "items", kind: "gateway", id: "ser7-cpa", meta: "" },
        },
      },
      { pi: stubPi },
    );
    expect(next).toBe("back");
    expect(state.notifyCalls.some((n) => n.message.includes("credential: missing"))).toBe(true);
    expect(state.notifyCalls.some((n) => n.message.includes("wire to applyProfile"))).toBe(false);
  });

  it("handleItemResult pick on a skill item notifies name + description", async () => {
    const { ctx, state } = makeCtx();
    const next = await handleItemResult(
      ctx,
      {
        action: "pick",
        item: {
          id: "skill:memory",
          label: "[skill] memory",
          data: { level: "items", kind: "skill", id: "memory", meta: "long term memory" },
        },
      },
      {},
    );
    expect(next).toBe("back");
    const msg = state.notifyCalls.at(-1)?.message ?? "";
    expect(msg).toContain("memory");
    expect(msg).toContain("long term memory");
  });

  it("handleItemResult cancel returns to category", async () => {
    const { ctx } = makeCtx();
    const next = await handleItemResult(ctx, { action: "cancel" }, {});
    expect(next).toBe("back");
  });
});

describe("content-model console — gateways providers/models navigation", () => {
  it("builds provider and model lists from the gateway profile", () => {
    const repoPath = makeRepo();
    seedRepo();
    const providers = buildProviderList({ repoPath }, "ser7-cpa");
    expect(providers[0].data.kind).toBe("provider");
    expect(providers[0].data.id).toBe("ser7-cpa");
    expect(providers[0].meta).toContain("model");
    const models = buildModelList({ repoPath }, "ser7-cpa", "ser7-cpa");
    expect(models[0].data.kind).toBe("model");
    expect(models[0].data.id).toBe("deepseek-v4-flash");
    // 未知 gateway/provider → 空列表
    expect(buildProviderList({ repoPath }, "nope")).toEqual([]);
    expect(buildModelList({ repoPath }, "ser7-cpa", "nope")).toEqual([]);
  });

  it("handleGatewayListResult pick on a gateway enters providers; unknown gateway notifies error", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleGatewayListResult(ctx, {
      action: "pick",
      item: {
        id: "gateway:ser7-cpa",
        label: "[gateway] ser7-cpa",
        data: { level: "items", kind: "gateway", id: "ser7-cpa", meta: "" },
      },
    });
    expect(next).toBe("providers");
    const bad = await handleGatewayListResult(ctx, {
      action: "pick",
      item: {
        id: "gateway:nope",
        label: "[gateway] nope",
        data: { level: "items", kind: "gateway", id: "nope", meta: "" },
      },
    });
    expect(bad).toBe("back");
    expect(state.notifyCalls.some((n) => n.message.includes("Unknown gateway: nope"))).toBe(true);
  });

  it("provider pick enters models; unknown provider notifies error", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedRepo();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleProviderListResult(ctx, "ser7-cpa", {
      action: "pick",
      item: {
        id: "ser7-cpa",
        label: "[provider] ser7-cpa",
        data: { level: "providers", kind: "provider", id: "ser7-cpa", meta: "openai-completions" },
      },
    });
    expect(next).toBe("models");
    const bad = await handleProviderListResult(ctx, "ser7-cpa", {
      action: "pick",
      item: {
        id: "nope",
        label: "[provider] nope",
        data: { level: "providers", kind: "provider", id: "nope", meta: "" },
      },
    });
    expect(bad).toBe("back");
    expect(state.notifyCalls.some((n) => n.message.includes("Unknown provider: nope"))).toBe(true);
  });

  it("provider add flow: /models toggle → addProviderToGateway committed+pushed", async () => {
    useTempHome();
    vi.stubEnv("DPI_CREDENTIAL_REF_SER7_CPA", "!echo sk-test");
    vi.stubGlobal("fetch", mockFetch({ data: [{ id: "m1" }, { id: "m2" }] }));
    const work = await seedGitGateway();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: work });

    const { ctx, state } = makeCtx([{ action: "cancel", checked: ["m1", "m2"] }]);
    state.inputQueue = ["p2", "P2", "openai-completions"];
    const next = await handleProviderListResult(ctx, "ser7-cpa", { action: "add" });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.some((n) => n.message.includes("Provider p2 added"))).toBe(true);
    const gateway = scanGatewayProfiles(work).find((p) => p.id === "ser7-cpa")!;
    const p2 = gateway.providers.find((p) => p.id === "p2")!;
    expect(p2.models.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("provider delete flow removes the provider committed+pushed", async () => {
    useTempHome();
    vi.stubEnv("DPI_CREDENTIAL_REF_SER7_CPA", "!echo sk-test");
    const work = await seedGitGateway();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: work });
    const added = await addProviderToGateway(
      work,
      "ser7-cpa",
      { id: "p2", name: "P2", api: "openai-completions", models: [{ id: "m1" }] },
      "feat: add p2",
    );
    expect(added.ok).toBe(true);

    const { ctx, state } = makeCtx();
    const next = await handleProviderListResult(ctx, "ser7-cpa", {
      action: "delete",
      item: {
        id: "p2",
        label: "[provider] p2",
        data: { level: "providers", kind: "provider", id: "p2", meta: "" },
      },
    });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.some((n) => n.message.includes("Provider p2 removed"))).toBe(true);
    const gateway = scanGatewayProfiles(work).find((p) => p.id === "ser7-cpa")!;
    expect(gateway.providers.map((p) => p.id)).toEqual(["ser7-cpa"]);
  });

  it("model add flow appends new models from /models, skipping already-present ones", async () => {
    useTempHome();
    vi.stubEnv("DPI_CREDENTIAL_REF_SER7_CPA", "!echo sk-test");
    vi.stubGlobal("fetch", mockFetch({ data: [{ id: "m1" }, { id: "m2" }] }));
    const work = await seedGitGateway();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: work });
    const added = await addProviderToGateway(
      work,
      "ser7-cpa",
      { id: "p2", name: "P2", api: "openai-completions", models: [{ id: "m1" }] },
      "feat: add p2",
    );
    expect(added.ok).toBe(true);

    // 勾选集含已存在的 m1 → 只追加 m2
    const { ctx, state } = makeCtx([{ action: "cancel", checked: ["m1", "m2"] }]);
    const next = await handleModelListResult(ctx, "ser7-cpa", "p2", { action: "add" });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.some((n) => n.message.includes("Added 1 model to p2"))).toBe(true);
    const gateway = scanGatewayProfiles(work).find((p) => p.id === "ser7-cpa")!;
    expect(gateway.providers.find((p) => p.id === "p2")!.models.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("model delete flow removes the model committed+pushed", async () => {
    useTempHome();
    vi.stubEnv("DPI_CREDENTIAL_REF_SER7_CPA", "!echo sk-test");
    const work = await seedGitGateway();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: work });
    const added = await addProviderToGateway(
      work,
      "ser7-cpa",
      { id: "p2", name: "P2", api: "openai-completions", models: [{ id: "m1" }, { id: "m2" }] },
      "feat: add p2",
    );
    expect(added.ok).toBe(true);

    const { ctx, state } = makeCtx();
    const next = await handleModelListResult(ctx, "ser7-cpa", "p2", {
      action: "delete",
      item: {
        id: "m1",
        label: "[model] m1",
        data: { level: "models", kind: "model", id: "m1", meta: "" },
      },
    });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.some((n) => n.message.includes("Model m1 removed"))).toBe(true);
    const gateway = scanGatewayProfiles(work).find((p) => p.id === "ser7-cpa")!;
    expect(gateway.providers.find((p) => p.id === "p2")!.models.map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("content-model console — agents and machines", () => {
  function seedAgents(): void {
    for (const name of ["coder", "researcher"]) {
      mkdirSync(join(repo, "agents", name), { recursive: true });
      writeFileSync(join(repo, "agents", name, "SYSTEM.md"), `# ${name}\n`);
    }
    writeFileSync(
      join(repo, "agents", "coder", "agent.json"),
      JSON.stringify({ description: "default coder", skills: [], extensions: [] }),
    );
    writeFileSync(
      join(repo, "agents", "researcher", "agent.json"),
      JSON.stringify({ description: "research agent", skills: ["memory"], extensions: [] }),
    );
  }

  it("buildAgentList lists agents and marks the current one", () => {
    const repoPath = makeRepo();
    seedAgents();
    const items = buildAgentList({ repoPath, currentAgent: "coder" });
    expect(items.map((i) => i.data.id)).toEqual(["coder", "researcher"]);
    expect(items.find((i) => i.data.id === "coder")!.meta).toContain("current *");
    expect(items.find((i) => i.data.id === "researcher")!.meta).toBe("");
  });

  it("handleAgentListResult pick switches the current agent and reloads", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedAgents();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleAgentListResult(ctx, {
      action: "pick",
      item: { id: "researcher", label: "researcher", data: { level: "agents", kind: "agent", id: "researcher", meta: "" } },
    });
    expect(next).toBe("reopen");
    expect(loadConfig().currentAgent).toBe("researcher");
    expect(state.notifyCalls.some((n) => n.message.includes("Switched to agent: researcher"))).toBe(true);
  });

  it("handleAgentListResult status shows the declaration summary", async () => {
    useTempHome();
    const repoPath = makeRepo();
    seedAgents();
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleAgentListResult(ctx, {
      action: "status",
      item: { id: "researcher", label: "researcher", data: { level: "agents", kind: "agent", id: "researcher", meta: "" } },
    });
    expect(next).toBe("reopen");
    const msg = state.notifyCalls.at(-1)?.message ?? "";
    expect(msg).toContain("agent: researcher");
    expect(msg).toContain("skills: memory");
  });

  it("buildMachineList lists machine files; pick shows the content read-only", async () => {
    useTempHome();
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, "machines"), { recursive: true });
    writeFileSync(join(repoPath, "machines", "macbook-air.json"), JSON.stringify({ proxy: "" }));
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const items = buildMachineList({ repoPath });
    expect(items[0].data.kind).toBe("machine");
    expect(items[0].data.id).toBe("macbook-air");
    const { ctx, state } = makeCtx();
    const next = await handleMachineListResult(ctx, {
      action: "pick",
      item: { id: "macbook-air", label: "[machine] macbook-air", data: { level: "machines", kind: "machine", id: "macbook-air", meta: "" } },
    });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.at(-1)?.message).toContain('"proxy"');
  });

  it("handleMachineListResult rejects a path-traversal id", async () => {
    useTempHome();
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, "machines"), { recursive: true });
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath });
    const { ctx, state } = makeCtx();
    const next = await handleMachineListResult(ctx, {
      action: "pick",
      item: { id: "../../etc/passwd", label: "x", data: { level: "machines", kind: "machine", id: "../../etc/passwd", meta: "" } },
    });
    expect(next).toBe("reopen");
    expect(state.notifyCalls.some((n) => n.message.includes("Invalid machine name"))).toBe(true);
  });
});

describe("dpi console — sessions status line and Sessions delegation", () => {
  /** 在临时 HOME 的 dpi 目录写入 save-state.json（lastArchive），模拟最近归档 */
  function seedLastArchive(time = "2026-08-09T12:34:56.789Z"): void {
    const dpiDirPath = join(home, ".pi", "agent", "dpi");
    mkdirSync(dpiDirPath, { recursive: true });
    writeFileSync(
      join(dpiDirPath, "save-state.json"),
      JSON.stringify({ lastArchive: { time, session: "x.jsonl", result: "committed" } }),
    );
  }

  it("formatSessionsStatus shows record on/off and no archive without a bound repo", async () => {
    useTempHome();
    const on = await formatSessionsStatus({ ...loadConfig(), recordSessions: true, repoUrl: "" });
    expect(on).toBe("record: on · no archive");
    const off = await formatSessionsStatus({ ...loadConfig(), recordSessions: false, repoUrl: "" });
    expect(off).toBe("record: off · no archive");
  });

  it("formatSessionsStatus includes the last archive time from save-state", async () => {
    useTempHome();
    seedLastArchive();
    const line = await formatSessionsStatus({ ...loadConfig(), recordSessions: true, repoUrl: "" });
    expect(line).toBe("record: on · last archive 08-09 12:34");
  });

  it("formatSessionsStatus counts unpushed commits via a real git repo", async () => {
    useTempHome();
    const git = makeGitRepo(); // init 已 push 到 bare 远端
    repo = git.work;
    bare = git.bare;
    execFileSync(
      "git",
      ["-C", git.work, "-c", "user.name=dpi", "-c", "user.email=dpi@users.noreply.github.com", "commit", "--allow-empty", "-m", "unpushed"],
    );
    const line = await formatSessionsStatus({
      ...loadConfig(),
      recordSessions: true,
      repoUrl: "https://github.com/Myka2003/Agent.git",
      repoPath: git.work,
    });
    expect(line).toBe("record: on · no archive · 1 unpushed");
  });

  it("handleCategoryResult Sessions delegates to runSessionBrowser with the full status prefix", async () => {
    useTempHome();
    const git = makeGitRepo();
    repo = git.work;
    bare = git.bare;
    seedLastArchive();
    execFileSync(
      "git",
      ["-C", git.work, "-c", "user.name=dpi", "-c", "user.email=dpi@users.noreply.github.com", "commit", "--allow-empty", "-m", "unpushed"],
    );
    saveConfig({ repoUrl: "https://github.com/Myka2003/Agent.git", repoPath: git.work });

    const stubPi = { registerProvider: vi.fn(), unregisterProvider: vi.fn() } as unknown as ExtensionAPI;
    const { ctx } = makeCtx();
    const next = await handleCategoryResult(
      ctx,
      {
        action: "pick",
        item: {
          id: "Sessions",
          label: "Sessions",
          data: { level: "category", kind: "category", id: "Sessions", meta: "" },
        },
      },
      { pi: stubPi },
    );

    expect(next).toBe("back");
    expect(runSessionBrowser).toHaveBeenCalledWith(stubPi, ctx, {
      titlePrefix: "Session Archive — record: on · last archive 08-09 12:34 · 1 unpushed",
    });
  });
});
