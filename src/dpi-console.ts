/**
 * dpi-console：统一 /dpi 控制台（0.8.43 内容模型驱动导航）。
 *
 * 状态机（runConsole）：
 * - top：绑定仓库条目（repo:current，pick 进入 category）+「+ Add repo」条目。
 * - category：六个固定分类 Agents / Skills / Extensions / Gateways / Sessions /
 *   Machines。Skills/Extensions 进入 runRegistryManager；Sessions 直接复用
 *   session-browser 的 runSessionBrowser（标题附加 record/归档/未推送状态行）；
 *   Agents/Gateways/Machines 进入各自条目列表。
 * - gateways：gateway 条目（add/delete/status 复用既有逻辑）；Enter 进入供应商列表。
 * - providers：gateway 的供应商列表（a 添加→/models 勾选→addProviderToGateway，
 *   d 确认删除→removeProvider）；Enter 进入模型列表。
 * - models：供应商的模型列表（a 从 /models toggle 追加→addModelsToProvider，
 *   d 确认删除→removeModel）；Esc 逐级返回。
 * - agents：scanAgents 列表，当前 agent 标 *；Enter 切换（saveConfig + reload），
 *   s 声明摘要。
 * - machines：machines/*.json 文件名列表；Enter 只读展示文件内容。
 *
 * 旧的扁平构建（buildConsoleItems / handleConsoleResult）与三层构建
 * （buildItemList / handleItemResult）保留不动，供既有测试与兼容复用。
 *
 * add-gateway 流程严格按顺序：输入 id/label/baseUrl/key → fetchGatewayModels →
 * buildGatewayProfile（schema 2，key 直接写进 profile）→ writeGatewayProfile →
 * commitPushGateway → notify；key 只传给 fetchGatewayModels 与 profile，绝不进
 * notify / 日志。schema 2 不再落 credential store（私有仓库即安全边界），
 * credential-store 仅保留给 schema 1 兼容与其他用途。
 * 供应商/模型增删全部走 gateway-writer 的 mutate 路径（校验→写回→commit+push），
 * 失败 { ok:false } 不抛，UI 层 notify。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错），
 * 由 extensions/dpi-console.ts 薄壳调用。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  loadConfig,
  readAgentManifest,
  saveConfig,
  scanAgents,
  syncExtensionFilter,
  type DpiConfig,
} from "./config.ts";
import { inspectRepo } from "./repo-doctor.ts";
import { useGateway } from "../extensions/gateway-manager.ts";
import { runSessionBrowser } from "../extensions/session-browser.ts";
import { safeAgentName } from "./common.ts";
import { deleteCredential, validateRef } from "./credential-store.ts";
import { fetchGatewayModels } from "./gateway-catalog.ts";
import { checkGatewayHealth } from "./gateway-health.ts";
import {
  ALLOWED_APIS,
  directGatewayKey,
  resolveCredentialRef,
  scanGatewayProfiles,
  type GatewayModel,
  type GatewayProfile,
} from "./gateway-profile.ts";
import {
  addModelsToProvider,
  addProviderToGateway,
  buildGatewayProfile,
  commitPushGateway,
  deleteGatewayProfile,
  ensureGatewayDirsSparse,
  removeModel,
  removeProvider,
  writeGatewayProfile,
} from "./gateway-writer.ts";
import { runRegistryManager } from "./registry-manager.ts";
import { bindRepoWithKey } from "./repo-binder.ts";
import { pendingCommits, readSaveState } from "./save-state.ts";
import { showVimListPicker, type VimListAction, type VimListItem, type VimListResult } from "./vim-list-picker.ts";
import { config as extManagerConfig, scanRegistryExtensions } from "../extensions/ext-manager.ts";
import { config as skillManagerConfig, scanRegistrySkills } from "../extensions/skill-manager.ts";

const runSecret = promisify(execFile);

export type ConsoleItemKind = "gateway" | "repo" | "skill" | "ext";

export interface ConsoleItemData {
  kind: ConsoleItemKind;
  id: string;
  meta: string;
}

export interface ConsoleItemsConfig {
  repoPath: string;
  repoUrl: string;
  currentGateway: string;
  /** 当前 agent（可选）：用于标记已声明的 skill/ext */
  currentAgent?: string;
}

export function buildConsoleItems(cfg: ConsoleItemsConfig): VimListItem<ConsoleItemData>[] {
  const items: VimListItem<ConsoleItemData>[] = [];
  if (cfg.repoUrl) {
    items.push({
      id: "repo:current",
      label: `[repo] ${cfg.repoUrl}`,
      meta: "bound",
      data: { kind: "repo", id: "current", meta: "bound" },
    });
  }
  for (const profile of scanGatewayProfiles(cfg.repoPath)) {
    items.push({
      id: `gateway:${profile.id}`,
      label: `[gateway] ${profile.id}${profile.label ? ` — ${profile.label}` : ""}`,
      meta:
        profile.id === cfg.currentGateway
          ? "selected *"
          : `${profile.providers.length} provider${profile.providers.length === 1 ? "" : "s"}`,
      data: { kind: "gateway", id: profile.id, meta: profile.baseUrl },
    });
  }
  // skill/ext 复用 skill-manager / ext-manager 的注册表扫描函数；已声明项打标
  const declared = readAgentManifest(cfg.repoPath, safeAgentName(cfg.currentAgent ?? "coder"));
  for (const skill of scanRegistrySkills(cfg.repoPath)) {
    items.push({
      id: `skill:${skill.name}`,
      label: skill.description ? `[skill] ${skill.name} — ${skill.description}` : `[skill] ${skill.name}`,
      meta: declared.skills.includes(skill.name) ? "declared" : "",
      data: { kind: "skill", id: skill.name, meta: skill.description },
    });
  }
  for (const ext of scanRegistryExtensions(cfg.repoPath)) {
    items.push({
      id: `ext:${ext.name}`,
      label: `[ext] ${ext.name}`,
      meta: declared.extensions.includes(ext.name) ? "declared" : "",
      data: { kind: "ext", id: ext.name, meta: ext.description },
    });
  }
  return items;
}

/**
 * add-gateway 流程（严格按顺序）：
 * 输入 id/label/baseUrl/key → fetchGatewayModels → buildGatewayProfile（schema 2，
 * key 直接写进 profile）→ writeGatewayProfile → commitPushGateway → notify。
 * schema 2 不再创建 credential（私有仓库即安全边界）；失败即返回，不留半成品。
 * options.fetchImpl 仅测试注入用；key 只传给 fetchGatewayModels 与 profile，
 * 绝不进 notify / 日志。
 */
export async function addGatewayFlow(
  ctx: ExtensionCommandContext,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoUrl || !cfg.repoPath) {
    ctx.ui.notify("No content repo bound; add one first (a → repo)", "warning");
    return;
  }
  const id = ((await ctx.ui.input("Gateway id (lowercase, dashes ok)", "")) ?? "").trim();
  if (!validateRef(id)) {
    ctx.ui.notify(`Invalid gateway id: ${id}`, "error");
    return;
  }
  const label = ((await ctx.ui.input("Label", id)) ?? "").trim() || id;
  const baseUrl = ((await ctx.ui.input("Base URL (…/v1)", "")) ?? "").trim();
  const key = ((await ctx.ui.input("API key", "")) ?? "").trim();
  if (!baseUrl || !key) {
    ctx.ui.notify("baseUrl and API key are required", "error");
    return;
  }

  let models: GatewayModel[];
  try {
    models = await fetchGatewayModels(baseUrl, key, { fetchImpl: options.fetchImpl });
  } catch (error) {
    ctx.ui.notify(`Model scan failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  // schema 2：key 直接写进 profile，不再落 credential store
  const profile = buildGatewayProfile({
    id,
    label,
    baseUrl,
    apiKey: key,
    credentialRef: id,
    providerId: id,
    api: "openai-completions",
    models,
  });
  if (!profile) {
    ctx.ui.notify("Profile failed validation (check baseUrl)", "error");
    return;
  }
  if (!writeGatewayProfile(cfg.repoPath, profile)) {
    ctx.ui.notify("Failed to write profile", "error");
    return;
  }
  const result = await commitPushGateway(cfg.repoPath, id, `feat: add gateway ${id}`);
  ctx.ui.notify(
    `Gateway ${id} added (commit=${result.committed}, push=${result.pushed})${result.error ? ` — ${result.error}; run /sync later` : ""}`,
    result.pushed ? "info" : "warning",
  );
}

/** add-repo：GitHub URL + SSH key → bindRepoWithKey（写 ~/.ssh key/config、
 * credential dpi-agent-repo-key、saveConfig、clone+sparse）；失败时通知错误，
 * key/credential 保留供诊断（不再暂存孤儿 repo-<ts> credential）。 */
export async function addRepoFlow(ctx: ExtensionCommandContext): Promise<void> {
  const repoUrl = ((await ctx.ui.input("GitHub repo (https://github.com/user/repo)", "")) ?? "").trim();
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) {
    ctx.ui.notify("Expected https://github.com/owner/repo", "error");
    return;
  }
  const key = ((await ctx.ui.input("SSH private key", "")) ?? "").trim();
  if (!key) {
    ctx.ui.notify("SSH private key required", "error");
    return;
  }
  const result = await bindRepoWithKey(repoUrl, key);
  if (!result.ok) {
    ctx.ui.notify(
      `Repo bind failed: ${result.error ?? "unknown error"} — SSH key and credential kept for diagnosis`,
      "warning",
    );
    return;
  }
  ctx.ui.notify("Repo bound: SSH key installed, sparse clone ready", "info");
}

/**
 * 按键路由：
 * - add：gateway → addGatewayFlow；repo → addRepoFlow；skill/ext → 各自的
 *   registry manager（复用 runRegistryManager）
 * - delete：gateway → 删 profile + commit；repo → 清 dpi-agent-repo-key 凭证（绑定保留）；
 *   skill/ext → registry manager
 * - status：gateway → checkGatewayHealth 报告；repo/skill/ext → 摘要
 * - pick：gateway/skill/ext 在扩展层处理（useGateway / 名称+描述）；repo → status 提示
 * 返回 "reopen" 表示重开列表（注册表可能已变化），"done" 表示退出控制台。
 */
export async function handleConsoleResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleItemData>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<"reopen" | "done"> {
  if (!result.item) {
    if (result.action === "add") {
      // 空列表 + add：未绑定 repo 时直接走 addRepoFlow（绑定成功后重开列表）；
      // 已绑定则无可添加对象，通知后退出，避免无限重开空列表。
      if (!loadConfig().repoUrl) {
        await addRepoFlow(ctx);
        return "reopen";
      }
      ctx.ui.notify("Nothing to add — bind a repo or add a gateway from the list", "info");
      return "done";
    }
    return "done";
  }
  const item = result.item.data;

  if (result.action === "add") {
    if (item.kind === "gateway") {
      await addGatewayFlow(ctx, options);
      return "reopen";
    }
    if (item.kind === "repo") {
      await addRepoFlow(ctx);
      return "reopen";
    }
    // skill/ext 的 add 走各自的 registry manager（安装流程与 /dpi-skills 一致）
    await runRegistryManager(ctx, item.kind === "skill" ? skillManagerConfig : extManagerConfig);
    return "reopen";
  }

  if (result.action === "delete" && item.kind === "gateway") {
    const cfg = loadConfig();
    // 稀疏检出必须先含 profiles/ 再删文件：否则 commitPushGateway 内部的稀疏兑底
    // 会把已删文件从 index 恢复回工作区，删除永远不会被提交（文件“复活”）。
    if (cfg.repoPath && (await ensureGatewayDirsSparse(cfg.repoPath))) {
      if (deleteGatewayProfile(cfg.repoPath, item.id)) {
        await commitPushGateway(cfg.repoPath, item.id, `chore: remove gateway ${item.id}`).catch(() => {});
      }
    }
    return "reopen";
  }

  if (result.action === "delete" && item.kind === "repo") {
    // 删除 addRepoFlow/binder 使用的凭证引用（~/.ssh key/config 与绑定保留，可再登录）
    deleteCredential("dpi-agent-repo-key");
    ctx.ui.notify("Repo binding kept; use /dpi-agent-login to rebind", "info");
    return "reopen";
  }

  if (result.action === "delete") {
    // skill/ext 删除走各自的 registry manager（confirm + 从声明剔除 + reload）
    await runRegistryManager(ctx, item.kind === "skill" ? skillManagerConfig : extManagerConfig);
    return "reopen";
  }

  if (result.action === "status") {
    if (item.kind === "gateway") {
      const cfg = loadConfig();
      const profile = cfg.repoPath
        ? scanGatewayProfiles(cfg.repoPath).find((p) => p.id === item.id)
        : undefined;
      if (!profile) {
        ctx.ui.notify(`Unknown gateway: ${item.id}`, "error");
        return "done";
      }
      const report = await checkGatewayHealth(profile);
      const lines = [
        `Gateway: ${profile.id}`,
        `credential: ${report.credential}`,
        `providers: ${report.providers}`,
        `models: ${report.models}`,
        `/models: ${report.endpoint}${report.latencyMs !== undefined ? ` (${report.latencyMs} ms)` : ""}`,
        ...(report.issues.length ? ["issues:", ...report.issues.map((issue) => `- ${issue}`)] : []),
      ];
      ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "warning");
    } else if (item.kind === "repo") {
      ctx.ui.notify(`repo status: ${item.id}`, "info");
    } else {
      ctx.ui.notify(`status requested: ${item.id}`, "info");
    }
    return "done";
  }

  if (result.action === "pick") {
    if (item.kind === "gateway") {
      ctx.ui.notify(`use gateway: ${item.id} (wire to applyProfile in extension)`, "info");
    } else if (item.kind === "repo") {
      ctx.ui.notify("repo status (wire to inspectRepo)", "info");
    }
    return "done";
  }

  return "done";
}

// ============================================================================
// 内容模型驱动导航（0.8.43）：top（repo 列表）→ category（六个分类）→
// 各分类条目列表。Gateways 深入两级：gateway 列表 → 供应商列表 → 模型列表。
// 旧的扁平构建（buildConsoleItems / handleConsoleResult）与三层构建
// （buildItemList / handleItemResult）保留，供既有测试与兼容复用。
// ============================================================================

export type ConsoleLevel = "top" | "category" | "items" | "gateways" | "providers" | "models" | "agents" | "machines";

export type ConsoleNavKind =
  | "repo"
  | "category"
  | "gateway"
  | "provider"
  | "model"
  | "skill"
  | "ext"
  | "agent"
  | "machine";

export interface ConsoleNavData {
  level: ConsoleLevel;
  kind: ConsoleNavKind;
  id: string;
  meta: string;
}

export type ItemKind = "gateway" | "skill" | "ext";

/** top 层：绑定仓库条目（pick 进入 category）+「+ Add repo」条目（绑定仓库）。 */
export function buildTopItems(cfg: { repoUrl: string; repoPath: string }): VimListItem<ConsoleNavData>[] {
  const items: VimListItem<ConsoleNavData>[] = [];
  if (cfg.repoUrl) {
    items.push({
      id: "repo:current",
      label: `[repo] ${cfg.repoUrl}`,
      meta: "bound",
      data: { level: "top", kind: "repo", id: "current", meta: "bound" },
    });
  }
  items.push({
    id: "repo:add",
    label: "+ Add repo (bind content repo)",
    meta: "",
    data: { level: "top", kind: "repo", id: "add", meta: "" },
  });
  return items;
}

/** Sessions 状态行：record on/off（loadConfig().recordSessions）· 最后归档时间
 * （readSaveState().lastArchive）· 未推送提交数（pendingCommits）。 */
export async function formatSessionsStatus(cfg: DpiConfig): Promise<string> {
  const state = readSaveState();
  const pending = cfg.repoUrl ? await pendingCommits(cfg) : null;
  const record = cfg.recordSessions ? "on" : "off";
  const archive =
    state.lastArchive && typeof state.lastArchive.time === "string"
      ? `last archive ${state.lastArchive.time.slice(5, 16).replace("T", " ")}`
      : "no archive";
  const unpushed = pending === null ? "" : ` · ${pending} unpushed`;
  return `record: ${record} · ${archive}${unpushed}`;
}

/** category 层：Agents / Skills / Extensions / Gateways / Sessions / Machines
 * 六个固定分类；cfg.sessionsStatus 由 runConsole 预计算（Sessions 条目状态行）。 */
export function buildCategoryItems(
  cfg?: { sessionsStatus?: string },
): VimListItem<ConsoleNavData>[] {
  const sessionsMeta = cfg?.sessionsStatus
    ? `browse archives · ${cfg.sessionsStatus}`
    : "browse archives";
  return [
    {
      id: "Agents",
      label: "Agents",
      meta: "switch agent · declarations",
      data: { level: "category", kind: "category", id: "Agents", meta: "switch agent · declarations" },
    },
    {
      id: "Skills",
      label: "Skills",
      meta: "manage declared skills",
      data: { level: "category", kind: "category", id: "Skills", meta: "manage declared skills" },
    },
    {
      id: "Extensions",
      label: "Extensions",
      meta: "manage declared extensions",
      data: { level: "category", kind: "category", id: "Extensions", meta: "manage declared extensions" },
    },
    {
      id: "Gateways",
      label: "Gateways",
      meta: "list / add / delete gateway profiles",
      data: { level: "category", kind: "category", id: "Gateways", meta: "list / add / delete gateway profiles" },
    },
    {
      id: "Sessions",
      label: "Sessions",
      meta: sessionsMeta,
      data: { level: "category", kind: "category", id: "Sessions", meta: sessionsMeta },
    },
    {
      id: "Machines",
      label: "Machines",
      meta: "machine settings (read-only)",
      data: { level: "category", kind: "category", id: "Machines", meta: "machine settings (read-only)" },
    },
  ];
}

/** items 层：gateway/skill/ext 条目列表（gateway 复用 scanGatewayProfiles；
 * skill/ext 复用注册表扫描，已声明项打标）。 */
export function buildItemList(
  cfg: { repoPath: string; currentGateway: string; currentAgent?: string },
  kind: ItemKind,
): VimListItem<ConsoleNavData>[] {
  if (kind === "gateway") {
    return scanGatewayProfiles(cfg.repoPath).map((profile) => ({
      id: `gateway:${profile.id}`,
      label: `[gateway] ${profile.id}${profile.label ? ` — ${profile.label}` : ""}`,
      meta:
        profile.id === cfg.currentGateway
          ? "selected *"
          : `${profile.providers.length} provider${profile.providers.length === 1 ? "" : "s"}`,
      data: { level: "items", kind: "gateway", id: profile.id, meta: profile.baseUrl },
    }));
  }
  const declared = readAgentManifest(cfg.repoPath, safeAgentName(cfg.currentAgent ?? "coder"));
  if (kind === "skill") {
    return scanRegistrySkills(cfg.repoPath).map((skill) => ({
      id: `skill:${skill.name}`,
      label: skill.description ? `[skill] ${skill.name} — ${skill.description}` : `[skill] ${skill.name}`,
      meta: declared.skills.includes(skill.name) ? "declared" : "",
      data: { level: "items", kind: "skill", id: skill.name, meta: skill.description },
    }));
  }
  return scanRegistryExtensions(cfg.repoPath).map((ext) => ({
    id: `ext:${ext.name}`,
    label: `[ext] ${ext.name}`,
    meta: declared.extensions.includes(ext.name) ? "declared" : "",
    data: { level: "items", kind: "ext", id: ext.name, meta: ext.description },
  }));
}

/** providers 层：所选 gateway 的供应商列表（数据来自 scanGatewayProfiles）。 */
export function buildProviderList(
  cfg: { repoPath: string },
  gatewayId: string,
): VimListItem<ConsoleNavData>[] {
  const profile = scanGatewayProfiles(cfg.repoPath).find((p) => p.id === gatewayId);
  if (!profile) return [];
  return profile.providers.map((provider) => ({
    id: provider.id,
    label: provider.name ? `[provider] ${provider.id} — ${provider.name}` : `[provider] ${provider.id}`,
    meta: `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
    data: { level: "providers", kind: "provider", id: provider.id, meta: provider.api },
  }));
}

/** models 层：所选供应商的模型列表。 */
export function buildModelList(
  cfg: { repoPath: string },
  gatewayId: string,
  providerId: string,
): VimListItem<ConsoleNavData>[] {
  const profile = scanGatewayProfiles(cfg.repoPath).find((p) => p.id === gatewayId);
  const provider = profile?.providers.find((p) => p.id === providerId);
  if (!provider) return [];
  return provider.models.map((m) => ({
    id: m.id,
    label: `[model] ${m.id}${m.name ? ` — ${m.name}` : ""}`,
    meta: m.input?.includes("image") ? "vision" : "",
    data: { level: "models", kind: "model", id: m.id, meta: "" },
  }));
}

/** agents 层：scanAgents 列表，当前 agent 标 *。 */
export function buildAgentList(
  cfg: { repoPath: string; currentAgent?: string },
): VimListItem<ConsoleNavData>[] {
  const current = safeAgentName(cfg.currentAgent ?? "coder");
  return scanAgents(cfg.repoPath).map((name) => {
    const desc = readAgentManifest(cfg.repoPath, name).description;
    return {
      id: name,
      label: desc ? `${name} — ${desc}` : name,
      meta: name === current ? "current *" : "",
      data: { level: "agents", kind: "agent", id: name, meta: "" },
    };
  });
}

/** machines 层：machines/*.json 文件名列表。 */
export function buildMachineList(cfg: { repoPath: string }): VimListItem<ConsoleNavData>[] {
  try {
    return readdirSync(join(cfg.repoPath, "machines"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""))
      .sort()
      .map((name) => ({
        id: name,
        label: `[machine] ${name}`,
        meta: "",
        data: { level: "machines", kind: "machine", id: name, meta: "" },
      }));
  } catch {
    return [];
  }
}

/** top 层结果路由：pick 仓库 → "enter"（进 category）；a / pick add 条目 →
 * addRepoFlow → "reopen"（重开 top 列表）；s → inspectRepo 状态摘要 → "reopen"；
 * cancel → "done"（退出控制台）。 */
export async function handleTopResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
): Promise<"enter" | "reopen" | "done"> {
  if (!result || result.action === "cancel") return "done";
  if (result.action === "add") {
    await addRepoFlow(ctx);
    return "reopen";
  }
  if (result.action === "status") {
    const report = await inspectRepo({ network: false });
    const lines = [
      `repo: ${report.remoteUrl || "(not bound)"}`,
      `branch: ${report.branch || "—"}`,
      `head: ${report.head || "—"}`,
      report.dirty ? "dirty: yes" : "dirty: clean",
      ...(report.issues.length ? ["issues:", ...report.issues] : []),
    ];
    ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "warning");
    return "reopen";
  }
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "repo" && item.id === "add") {
      await addRepoFlow(ctx);
      return "reopen";
    }
    // 绑定的仓库条目 pick → 进入 category 层
    return "enter";
  }
  return "done";
}

export type CategoryNav = "gateways" | "agents" | "machines" | "back";

/** category 层结果路由：Agents/Gateways/Machines → 进入各自列表；
 * Skills/Extensions → runRegistryManager → "back"（回 top）；
 * Sessions → runSessionBrowser（标题附加状态行）→ "back"；
 * cancel（Esc）→ "back"（回 top，顶层再按 Esc 退出控制台）。 */
export async function handleCategoryResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
  options: { pi?: ExtensionAPI; fetchImpl?: typeof fetch } = {},
): Promise<CategoryNav> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const id = result.item.data.id;
    if (id === "Agents") return "agents";
    if (id === "Skills") {
      await runRegistryManager(ctx, skillManagerConfig);
      return "back";
    }
    if (id === "Extensions") {
      await runRegistryManager(ctx, extManagerConfig);
      return "back";
    }
    if (id === "Gateways") return "gateways";
    if (id === "Sessions") {
      if (!options.pi) {
        ctx.ui.notify("Session browser unavailable (no extension context)", "error");
        return "back";
      }
      const prefix = `Session Archive — ${await formatSessionsStatus(loadConfig())}`;
      await runSessionBrowser(options.pi, ctx, { titlePrefix: prefix });
      return "back";
    }
    if (id === "Machines") return "machines";
  }
  return "back";
}

function toLegacyKind(kind: ConsoleNavKind): ConsoleItemData["kind"] {
  if (kind === "category") return "repo";
  if (kind === "provider" || kind === "model" || kind === "agent" || kind === "machine") {
    return "gateway"; // 新层级不应走到旧 items 路径；安全回退到 gateway
  }
  return kind;
}

/** items 层结果路由：pick gateway → useGateway（pi 注入时真实接线，否则占位提示）
 * → "back"（回 category）；pick skill/ext → 名称+描述 → "back"；
 * add/delete/status 复用 handleConsoleResult（空列表 add 直接走 addGatewayFlow）；
 * cancel → "back"。（0.8.43 起 runConsole 不再使用本函数——gateway pick 改为
 * 进入供应商列表；保留供既有测试与兼容。） */
export async function handleItemResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
  options: { pi?: ExtensionAPI; fetchImpl?: typeof fetch } = {},
): Promise<"back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "gateway") {
      if (options.pi) {
        await useGateway(options.pi, item.id, ctx);
      } else {
        ctx.ui.notify(`use gateway: ${item.id} (wire to applyProfile in extension)`, "info");
      }
      return "back";
    }
    if (item.kind === "skill" || item.kind === "ext") {
      ctx.ui.notify(
        item.meta ? `${item.kind}: ${item.id} — ${item.meta}` : `${item.kind}: ${item.id}`,
        "info",
      );
      return "back";
    }
    return "back";
  }
  // 空列表 add：gateway 上下文直接走 addGatewayFlow（不落到 addRepoFlow）
  if (result.action === "add" && !result.item) {
    await addGatewayFlow(ctx, options);
    return "reopen";
  }
  const legacy: VimListResult<ConsoleItemData> = {
    action: result.action,
    item: result.item
      ? {
          id: result.item.id,
          label: result.item.label,
          meta: result.item.meta,
          data: {
            kind: toLegacyKind(result.item.data.kind),
            id: result.item.data.id,
            meta: result.item.data.meta,
          },
        }
      : undefined,
    checked: result.checked,
  };
  const next = await handleConsoleResult(ctx, legacy, options);
  return next === "reopen" ? "reopen" : "back";
}

// ----------------------------------------------------------------------------
// 供应商 / 模型管理流程（0.8.43）：全部复用 gateway-writer 的 mutate 路径，
// 每个操作 commit+push；失败 { ok:false } 不抛，UI 层 notify。
// ----------------------------------------------------------------------------

/** 解析 gateway 的 API key：credentialRef → 命令解析 → 执行取明文（与
 * gateway-health 的 resolveSecret 同构）。失败返回 null（不抛）。schema 2 的
 * profile.apiKey 由调用方先经 directGatewayKey 处理，本函数只兜底旧路径。 */
async function resolveGatewayApiKey(profile: GatewayProfile): Promise<string | null> {
  if (typeof profile.credentialRef !== "string" || profile.credentialRef === "") return null;
  const credential = resolveCredentialRef(profile.credentialRef);
  if (credential.kind === "missing") return null;
  try {
    const { stdout } = await runSecret("/bin/sh", ["-lc", credential.value], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** 添加供应商（schema 2 直写）：输入 id/名称/api/baseUrl/apiKey → 从
 * {baseUrl}/models 拉模型（baseUrl/apiKey 留空回退到 gateway 级）→ toggle 勾选 →
 * addProviderToGateway（含 baseUrl/apiKey 直写 + 校验 + commit+push）。 */
export async function addProviderFlow(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoUrl || !cfg.repoPath) {
    ctx.ui.notify("No content repo bound; add one first (a → repo)", "warning");
    return;
  }
  const profile = scanGatewayProfiles(cfg.repoPath).find((p) => p.id === gatewayId);
  if (!profile) {
    ctx.ui.notify(`Unknown gateway: ${gatewayId}`, "error");
    return;
  }
  const id = ((await ctx.ui.input("Provider id (lowercase, dashes ok)", "")) ?? "").trim();
  if (!validateRef(id)) {
    ctx.ui.notify(`Invalid provider id: ${id}`, "error");
    return;
  }
  if (profile.providers.some((p) => p.id === id)) {
    ctx.ui.notify(`Provider exists: ${id}`, "error");
    return;
  }
  const name = ((await ctx.ui.input("Provider name", id)) ?? "").trim() || id;
  const apiInput = (
    (await ctx.ui.input(`API (${[...ALLOWED_APIS].join(" | ")})`, "openai-completions")) ?? ""
  ).trim();
  if (!ALLOWED_APIS.has(apiInput)) {
    ctx.ui.notify(`Invalid API: ${apiInput}`, "error");
    return;
  }
  // schema 2：provider 级 baseUrl/apiKey 直写；留空回退到 gateway 级
  const baseUrlInput = (
    (await ctx.ui.input(`Provider base URL (…/v1, Enter = ${profile.baseUrl})`, "")) ?? ""
  ).trim();
  const apiKeyInput = ((await ctx.ui.input("Provider API key (Enter = reuse gateway key)", "")) ?? "").trim();
  const providerBaseUrl = baseUrlInput || profile.baseUrl;
  // 直接 key 优先级：输入 → profile.apiKey → credentialRef 命令（schema 1 兼容）
  const key = apiKeyInput || profile.apiKey || (await resolveGatewayApiKey(profile));
  if (!key) {
    ctx.ui.notify(
      `No API key available for provider ${id} — enter one or add a gateway key first`,
      "error",
    );
    return;
  }
  let models: GatewayModel[];
  try {
    models = await fetchGatewayModels(providerBaseUrl, key, { fetchImpl: options.fetchImpl });
  } catch (error) {
    ctx.ui.notify(
      `Model scan failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const res = await showVimListPicker<GatewayModel>(ctx, {
    title: `Select models for provider ${id} (Space toggle, Esc done)`,
    items: models.map((m) => ({
      id: m.id,
      label: m.name ? `${m.id} — ${m.name}` : m.id,
      data: m,
    })),
    mode: "toggle",
    hint: "j/k nav · / filter · Space/Enter toggle · Esc done",
  });
  if (!res) return; // TUI 不可用/取消
  const selected = models.filter((m) => (res.checked ?? []).includes(m.id));
  const result = await addProviderToGateway(
    cfg.repoPath,
    gatewayId,
    {
      id,
      name,
      api: apiInput,
      models: selected,
      // schema 2 字段仅在用户填写时写入（避免 undefined 键污染对象）
      ...(baseUrlInput ? { baseUrl: baseUrlInput } : {}),
      ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
    },
    `feat: add provider ${id} to gateway ${gatewayId}`,
  );
  ctx.ui.notify(
    result.ok
      ? `Provider ${id} added to ${gatewayId} (commit+push ok, ${selected.length} model${selected.length === 1 ? "" : "s"})`
      : `Add provider failed: ${result.error}`,
    result.ok ? "info" : "error",
  );
}

/** 追加模型：/models 拉模型 → toggle 勾选（已存在项预勾选）→
 * addModelsToProvider（commit+push）。key 优先级：provider.apiKey →
 * profile.apiKey（schema 2 直用）→ credentialRef 命令（schema 1 兼容）。 */
export async function addModelsFlow(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  providerId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoUrl || !cfg.repoPath) {
    ctx.ui.notify("No content repo bound; add one first (a → repo)", "warning");
    return;
  }
  const profile = scanGatewayProfiles(cfg.repoPath).find((p) => p.id === gatewayId);
  const provider = profile?.providers.find((p) => p.id === providerId);
  if (!profile || !provider) {
    ctx.ui.notify(`Unknown provider: ${providerId}`, "error");
    return;
  }
  const providerBaseUrl = provider.baseUrl ?? profile.baseUrl;
  const key = directGatewayKey(profile, provider) ?? (await resolveGatewayApiKey(profile));
  if (key === null) {
    ctx.ui.notify(
      `No API key available for gateway ${gatewayId} — add a gateway/provider key first`,
      "error",
    );
    return;
  }
  let models: GatewayModel[];
  try {
    models = await fetchGatewayModels(providerBaseUrl, key, { fetchImpl: options.fetchImpl });
  } catch (error) {
    ctx.ui.notify(
      `Model scan failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const res = await showVimListPicker<GatewayModel>(ctx, {
    title: `Add models to ${providerId} (● already present)`,
    items: models.map((m) => ({
      id: m.id,
      label: m.name ? `${m.id} — ${m.name}` : m.id,
      checked: provider.models.some((x) => x.id === m.id),
      data: m,
    })),
    mode: "toggle",
    hint: "j/k nav · / filter · Space/Enter toggle · Esc done",
  });
  if (!res) return;
  const existing = new Set(provider.models.map((m) => m.id));
  const toAdd = models.filter((m) => (res.checked ?? []).includes(m.id) && !existing.has(m.id));
  if (toAdd.length === 0) {
    ctx.ui.notify("No new models selected (all already present)", "info");
    return;
  }
  const result = await addModelsToProvider(
    cfg.repoPath,
    gatewayId,
    providerId,
    toAdd,
    `feat: add ${toAdd.length} model${toAdd.length === 1 ? "" : "s"} to ${providerId}`,
  );
  ctx.ui.notify(
    result.ok
      ? `Added ${toAdd.length} model${toAdd.length === 1 ? "" : "s"} to ${providerId} (commit+push ok)`
      : `Add models failed: ${result.error}`,
    result.ok ? "info" : "error",
  );
}

/** 删除供应商：confirm → removeProvider（commit+push）。 */
export async function removeProviderFlow(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  providerId: string,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoPath) return;
  const ok = await ctx.ui.confirm(
    "Delete provider",
    `Delete provider "${providerId}" from gateway ${gatewayId}? Confirm?`,
  );
  if (!ok) return;
  const result = await removeProvider(
    cfg.repoPath,
    gatewayId,
    providerId,
    `chore: remove provider ${providerId} from gateway ${gatewayId}`,
  );
  ctx.ui.notify(
    result.ok
      ? `Provider ${providerId} removed (commit+push ok)`
      : `Remove provider failed: ${result.error}`,
    result.ok ? "info" : "error",
  );
}

/** 删除模型：confirm → removeModel（commit+push）。 */
export async function removeModelFlow(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  providerId: string,
  modelId: string,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoPath) return;
  const ok = await ctx.ui.confirm(
    "Delete model",
    `Delete model "${modelId}" from provider ${providerId}? Confirm?`,
  );
  if (!ok) return;
  const result = await removeModel(
    cfg.repoPath,
    gatewayId,
    providerId,
    modelId,
    `chore: remove model ${modelId} from ${providerId}`,
  );
  ctx.ui.notify(
    result.ok
      ? `Model ${modelId} removed (commit+push ok)`
      : `Remove model failed: ${result.error}`,
    result.ok ? "info" : "error",
  );
}

/** gateways 层结果路由：pick gateway（校验存在）→ "providers"（进入供应商
 * 列表）；其余 a/d/s/空列表 add 委托 handleItemResult（复用既有 add/delete/
 * status 逻辑）；cancel → "back"。 */
export async function handleGatewayListResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<"providers" | "back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "gateway") {
      const cfg = loadConfig();
      const profile = cfg.repoPath
        ? scanGatewayProfiles(cfg.repoPath).find((p) => p.id === item.id)
        : undefined;
      if (!profile) {
        ctx.ui.notify(`Unknown gateway: ${item.id}`, "error");
        return "back";
      }
      return "providers";
    }
    return "back";
  }
  return handleItemResult(ctx, result, options);
}

/** providers 层结果路由：pick provider（校验存在）→ "models"；a →
 * addProviderFlow → "reopen"；d → 确认 → removeProviderFlow → "reopen"；
 * cancel → "back"（回 gateways 层）。 */
export async function handleProviderListResult(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  result: VimListResult<ConsoleNavData>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<"models" | "back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "provider") {
      const cfg = loadConfig();
      const profile = cfg.repoPath
        ? scanGatewayProfiles(cfg.repoPath).find((p) => p.id === gatewayId)
        : undefined;
      const provider = profile?.providers.find((p) => p.id === item.id);
      if (!provider) {
        ctx.ui.notify(`Unknown provider: ${item.id}`, "error");
        return "back";
      }
      return "models";
    }
    return "back";
  }
  if (result.action === "add") {
    await addProviderFlow(ctx, gatewayId, options);
    return "reopen";
  }
  if (result.action === "delete" && result.item) {
    await removeProviderFlow(ctx, gatewayId, result.item.data.id);
    return "reopen";
  }
  return "back";
}

/** models 层结果路由：a → addModelsFlow → "reopen"；d → 确认 →
 * removeModelFlow → "reopen"；cancel → "back"（回 providers 层）。 */
export async function handleModelListResult(
  ctx: ExtensionCommandContext,
  gatewayId: string,
  providerId: string,
  result: VimListResult<ConsoleNavData>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<"back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "add") {
    await addModelsFlow(ctx, gatewayId, providerId, options);
    return "reopen";
  }
  if (result.action === "delete" && result.item) {
    await removeModelFlow(ctx, gatewayId, providerId, result.item.data.id);
    return "reopen";
  }
  return "back";
}

/** agents 层结果路由：pick agent → 切换（saveConfig + syncExtensionFilter +
 * reload，复用 /dpi-agent 语义）→ "reopen"；s → 声明摘要 → "reopen"；
 * cancel → "back"。 */
export async function handleAgentListResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
): Promise<"back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const name = result.item.data.id;
    const cfg = loadConfig();
    if (!cfg.repoPath || !scanAgents(cfg.repoPath).includes(name)) {
      ctx.ui.notify(`Unknown agent: ${name}`, "error");
      return "back";
    }
    if (name === cfg.currentAgent) {
      ctx.ui.notify(`Already on agent: ${name}`, "info");
      return "reopen";
    }
    saveConfig({ currentAgent: name });
    syncExtensionFilter(loadConfig());
    ctx.ui.notify(`Switched to agent: ${name}, reloading…`, "info");
    await ctx.reload();
    return "reopen";
  }
  if (result.action === "status" && result.item) {
    const name = result.item.data.id;
    const cfg = loadConfig();
    const manifest = readAgentManifest(cfg.repoPath, name);
    const lines = [
      `agent: ${name}`,
      manifest.description ? `description: ${manifest.description}` : "",
      `skills: ${manifest.skills.join(", ") || "(none)"}`,
      `extensions: ${manifest.extensions.join(", ") || "(none)"}`,
    ].filter((l) => l !== "");
    ctx.ui.notify(lines.join("\n"), "info");
    return "reopen";
  }
  return "back";
}

/** machines 层结果路由：pick machine → 只读展示文件内容 → "reopen"；
 * cancel → "back"。 */
export async function handleMachineListResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
): Promise<"back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const name = result.item.data.id;
    const cfg = loadConfig();
    if (!cfg.repoPath) return "back";
    // 白名单校验防路径穿越（id 来自目录扫描，但结果可被伪造）
    if (!/^[\w-]+$/.test(name)) {
      ctx.ui.notify(`Invalid machine name: ${name}`, "error");
      return "reopen";
    }
    try {
      const content = readFileSync(join(cfg.repoPath, "machines", `${name}.json`), "utf-8");
      ctx.ui.notify(`machine: ${name}\n${content.trim()}`, "info");
    } catch {
      ctx.ui.notify(`Cannot read machine file: ${name}`, "error");
    }
    return "reopen";
  }
  return "back";
}

/** 内容模型驱动导航主循环：按 level 状态机路由，构建列表 → 处理结果 → 切换
 * 层级。Gateways 深入两级（providers → models）；Agents/Machines 单层；
 * Sessions 直接调 session-browser。options.pi 由扩展层注入。 */
export async function runConsole(
  ctx: ExtensionCommandContext,
  options: { pi?: ExtensionAPI; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!ctx.hasUI) {
    const cfg = loadConfig();
    ctx.ui.notify(
      [
        cfg.repoUrl ? `repo: ${cfg.repoUrl}` : "repo: none — use /dpi a to bind",
        "categories: Agents · Skills · Extensions · Gateways · Sessions · Machines",
      ].join("\n"),
      "info",
    );
    return;
  }

  let level: ConsoleLevel = "top";
  let currentGateway = "";
  let currentProvider = "";
  for (;;) {
    const cfg = loadConfig();
    let items: VimListItem<ConsoleNavData>[] = [];
    let title = "dpi console";
    let actions: VimListAction[] | undefined;
    let hint = "";
    switch (level) {
      case "top":
        items = buildTopItems(cfg);
        title = "dpi console";
        actions = [
          { key: "a", id: "add", hint: "add" },
          { key: "s", id: "status", hint: "status" },
        ];
        hint = "j/k nav · / filter · Enter select · Esc quit";
        break;
      case "category":
        items = buildCategoryItems({ sessionsStatus: await formatSessionsStatus(cfg) });
        title = "dpi — category";
        hint = "j/k nav · / filter · Enter select · Esc back to top";
        break;
      case "gateways":
        items = buildItemList(cfg, "gateway");
        title = "dpi — gateways";
        actions = [
          { key: "a", id: "add", hint: "add" },
          { key: "d", id: "delete", hint: "delete" },
          { key: "s", id: "status", hint: "status" },
        ];
        hint = "j/k nav · / filter · Enter providers · Esc back to category";
        break;
      case "providers":
        items = buildProviderList(cfg, currentGateway);
        title = `dpi — ${currentGateway} providers`;
        actions = [
          { key: "a", id: "add", hint: "add provider" },
          { key: "d", id: "delete", hint: "delete provider" },
        ];
        hint = "j/k nav · / filter · Enter models · Esc back to gateways";
        break;
      case "models":
        items = buildModelList(cfg, currentGateway, currentProvider);
        title = `dpi — ${currentGateway}/${currentProvider} models`;
        actions = [
          { key: "a", id: "add", hint: "add models" },
          { key: "d", id: "delete", hint: "delete model" },
        ];
        hint = "j/k nav · / filter · Esc back to providers";
        break;
      case "agents":
        items = buildAgentList(cfg);
        title = "dpi — agents";
        actions = [{ key: "s", id: "status", hint: "declaration summary" }];
        hint = "j/k nav · / filter · Enter switch · Esc back to category";
        break;
      case "machines":
        items = buildMachineList(cfg);
        title = "dpi — machines";
        hint = "j/k nav · / filter · Enter inspect · Esc back to category";
        break;
      default:
        level = "top";
        continue;
    }
    const result = await showVimListPicker<ConsoleNavData>(ctx, {
      title,
      items,
      mode: "select",
      actions,
      hint,
    });
    if (!result) return; // TUI 不可用/异常

    if (level === "top") {
      const next = await handleTopResult(ctx, result);
      if (next === "done") return;
      if (next === "enter") level = "category";
      continue; // "reopen" 留在 top 层
    }
    if (level === "category") {
      const next = await handleCategoryResult(ctx, result, options);
      if (next === "back") {
        level = "top"; // Esc 或 registry manager / session browser 完成 → 回 top
      } else {
        level = next; // "gateways" | "agents" | "machines"
      }
      continue;
    }
    if (level === "gateways") {
      const next = await handleGatewayListResult(ctx, result, options);
      if (next === "providers" && result.item) {
        currentGateway = result.item.data.id;
        level = "providers";
      } else if (next === "back") {
        level = "category";
      }
      continue; // "reopen" 留在 gateways 层
    }
    if (level === "providers") {
      const next = await handleProviderListResult(ctx, currentGateway, result, options);
      if (next === "models" && result.item) {
        currentProvider = result.item.data.id;
        level = "models";
      } else if (next === "back") {
        level = "gateways";
      }
      continue; // "reopen" 留在 providers 层
    }
    if (level === "models") {
      const next = await handleModelListResult(ctx, currentGateway, currentProvider, result, options);
      if (next === "back") level = "providers";
      continue; // "reopen" 留在 models 层
    }
    if (level === "agents") {
      const next = await handleAgentListResult(ctx, result);
      if (next === "back") level = "category";
      continue; // "reopen" 留在 agents 层
    }
    const next = await handleMachineListResult(ctx, result);
    if (next === "back") level = "category";
    // "reopen" 留在 machines 层
  }
}
