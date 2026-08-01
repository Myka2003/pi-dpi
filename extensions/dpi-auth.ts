/**
 * dpi-auth：内容仓库绑定与登录（通用 git 远端）。
 *
 * 远端类型由地址格式自动识别（parseRepoRemote），不让用户选：
 * - github：user/repo、github.com/…、https://github.com/…，OAuth device flow 授权，
 *   token 单行存 0600 文件，地址归一化为 https://github.com/user/repo.git
 * - ssh：git@host:path、ssh://…（含 git@github.com:…），零凭证走本机 ssh key，
 *   绑定前 git ls-remote 探测可达性，地址按原样使用
 * - http：任意 https/http 托管（Gitea/Forgejo/GitLab/Codeberg…），交互问
 *   用户名 + 访问令牌，token 文件存两行（用户名\n令牌），credential helper 逐行输出
 * - local：绝对路径、~/…、file://…，零认证走 git 本地协议（~ 展开为 homedir）
 *
 * - /agent-login [repoUrl]：按类型走对应认证 → git clone 内容仓库 → 校验
 *   agents/*\/SYSTEM.md 存在（不是 dpi 内容仓库则不写配置）→ 写配置 →
 *   ctx.reload() 让资源立即生效
 * - /agent-logout：清除本机访问令牌（本地仓库与配置保留）
 *
 * 网络访问一律走 curl 子进程（自动吃 https_proxy 环境变量；显式代理加 -x），
 * 每一步独立容错，绝不抛出阻断 pi。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  defaultConfig,
  ensurePackageInSettings,
  hasToken,
  loadConfig,
  remoteNeedsToken,
  saveConfig,
  scanAgents,
  syncExtensionFilter,
  tokenPath,
  clearToken,
  writeToken,
} from "../src/config.ts";
import type { RemoteKind } from "../src/config.ts";
import { git, gitIn } from "../src/git.ts";
import { errMsg } from "../src/common.ts";
import { ensureContentRepo } from "../src/bootstrap.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

const run = promisify(execFile);

// GitHub OAuth App（device flow 公共 client_id，非机密）
const CLIENT_ID = "Ov23liYebWamOAtuWqe3";
// workflow scope：OAuth App 推送 .github/workflows/ 需要（GitHub 安全策略），否则 CI 文件被拒
const SCOPE = "repo workflow";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const HTTP_TIMEOUT = 20000;
const CLONE_TIMEOUT = 300000;
/** ssh/local 绑定时 ls-remote 探测的超时 */
const LS_REMOTE_TIMEOUT = 15000;
const LOGIN_WIDGET = "dpi-login";

/** 成功绑定提示里的远端类型标签 */
const KIND_LABEL: Record<RemoteKind, string> = {
  github: "GitHub",
  ssh: "SSH 远端（零凭证）",
  http: "通用 HTTPS（Gitea/GitLab/自托管）",
  local: "本地仓库",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** curl POST 表单（Accept: application/json），显式代理用 -x，否则吃环境变量 */
async function curlPostForm(
  url: string,
  form: Record<string, string>,
  proxy: string,
): Promise<Record<string, unknown>> {
  const args = ["-sS", "-X", "POST", "-H", "Accept: application/json"];
  if (proxy) args.push("-x", proxy);
  for (const [k, v] of Object.entries(form)) args.push("--data-urlencode", `${k}=${v}`);
  args.push(url);
  const { stdout } = await run("curl", args, { timeout: HTTP_TIMEOUT });
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`响应不是合法 JSON: ${stdout.slice(0, 200)}`);
  }
}

export interface RepoRemote {
  kind: RemoteKind;
  url: string;
}

/** 展开路径开头的 ~ 为 homedir（~/path 与 ~ 两种形式） */
function expandTilde(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

/** GitHub 写法（user/repo、github.com/user/repo、https://…）归一化为 https://github.com/user/repo.git；无法识别返回 null。git@github.com:… 由 parseRepoRemote 的 scp-like 分支先行判定为 ssh 类型，这里不再处理 */
function normalizeGithubUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, "");
  const m = /github\.com[/:]([^\s]+)$/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return null;
  return `https://github.com/${s}.git`;
}

/**
 * 识别远端类型并归一化地址：类型由地址格式自动判断，不让用户选。
 * - file://、绝对路径、~ 开头 → local（~ 展开为 homedir）
 * - ssh://、scp-like（user@host:path，含 git@github.com:…）→ ssh，地址原样
 * - http(s):// 含 github.com → github 归一化；其余托管 → http，地址原样
 * - user/repo、github.com/user/repo 短格式 → github 归一化
 * 无法识别返回 null。
 */
export function parseRepoRemote(input: string): RepoRemote | null {
  const s = input.trim().replace(/\/+$/, "");
  if (!s) return null;
  if (s.toLowerCase().startsWith("file://")) {
    return { kind: "local", url: expandTilde(s.slice("file://".length)) };
  }
  if (s.startsWith("/") || s.startsWith("~")) {
    return { kind: "local", url: expandTilde(s) };
  }
  if (s.toLowerCase().startsWith("ssh://")) {
    return { kind: "ssh", url: s };
  }
  if (/^[^\s/@:]+@[^\s/:]+:\S+$/.test(s)) {
    return { kind: "ssh", url: s };
  }
  if (/^https?:\/\//i.test(s)) {
    if (/github\.com/i.test(s)) {
      const url = normalizeGithubUrl(s);
      return url ? { kind: "github", url } : null;
    }
    return { kind: "http", url: s };
  }
  const gh = normalizeGithubUrl(s);
  return gh ? { kind: "github", url: gh } : null;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in?: number;
}

async function requestDeviceCode(proxy: string): Promise<DeviceCode> {
  const res = await curlPostForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE }, proxy);
  if (typeof res.device_code !== "string" || typeof res.user_code !== "string") {
    throw new Error(`设备码响应异常: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return res as unknown as DeviceCode;
}

/** 轮询换 token：pending 继续等、slow_down +5s、过期/拒绝报错，最长到 expires_in */
async function pollForToken(dc: DeviceCode, proxy: string): Promise<string> {
  let interval = Math.max(dc.interval ?? 5, 5);
  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("等待授权超时，授权码已过期");
    await sleep(interval * 1000);
    const res = await curlPostForm(
      ACCESS_TOKEN_URL,
      { client_id: CLIENT_ID, device_code: dc.device_code, grant_type: DEVICE_GRANT },
      proxy,
    );
    if (typeof res.access_token === "string" && res.access_token) return res.access_token;
    const err = res.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "expired_token") throw new Error("授权码已过期，请重新执行 /agent-login");
    if (err === "access_denied") throw new Error("授权被取消");
    throw new Error(`授权失败: ${String(err ?? "未知错误")}`);
  }
}

function clearLoginWidget(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(LOGIN_WIDGET, undefined);
}

/** 克隆（或复用已有）内容仓库到 repoPath，返回实际分支名；noAuth 时零凭证（ssh/local） */
async function ensureRepo(
  ctx: ExtensionCommandContext,
  repoUrl: string,
  repoPath: string,
  proxy: string,
  noAuth: boolean,
): Promise<string | null> {
  const gitOpts = { tokenFile: tokenPath(), proxy, noAuth };
  if (existsSync(repoPath)) {
    if (!existsSync(join(repoPath, ".git"))) {
      ctx.ui.notify(`目标目录已存在且不是 git 仓库：${repoPath}`, "error");
      return null;
    }
    // 已有本地仓库：重新指向 origin 并 fetch 远端新状态，跳过克隆
    try {
      await gitIn(repoPath, ["remote", "set-url", "origin", repoUrl], gitOpts);
      await gitIn(repoPath, ["fetch", "origin"], { ...gitOpts, timeoutMs: 60000 });
    } catch {
      // 指向/fetch 失败不阻断绑定（内容校验用本地 agents/，远端同步由 /sync 负责）
    }
    // 老仓库（全量模式）自动迁移到稀疏模式：sessions/ 从工作区移除（对象库保留，git 可恢复），
    // 之后浏览/恢复/归档按需走 git（与重构后的新克隆一致）
    let migrated = false;
    try {
      const { stdout } = await gitIn(repoPath, ["sparse-checkout", "list"], gitOpts);
      if (!stdout.trim()) {
        await gitIn(repoPath, ["sparse-checkout", "init", "--cone"], gitOpts);
        await gitIn(
          repoPath,
          ["sparse-checkout", "set", "agents", "skills", "extensions", "machines", "docs"],
          gitOpts,
        );
        migrated = true;
      }
    } catch {
      // 迁移失败不阻断（老模式仍可用）
    }
    ctx.ui.notify(
      migrated
        ? `本地仓库已存在，已转换为稀疏模式（sessions 按需拉取）：${repoPath}`
        : `本地仓库已存在，跳过克隆：${repoPath}`,
      "info",
    );
    try {
      const { stdout } = await gitIn(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim() || "main";
    } catch {
      return "main";
    }
  }
  // 稀疏克隆：blob:none（不拉文件内容）+ sparse-checkout 只检出运行时配置目录；
  // sessions/ 永不进工作区（浏览/恢复/归档按需走 git 对象库，见 spec）
  const SPARSE_DIRS = ["agents", "skills", "extensions", "machines", "docs"];
  const sparseClone = async (extra: string[]): Promise<void> => {
    await git(["clone", "--filter=blob:none", "--sparse", ...extra, repoUrl, repoPath], {
      ...gitOpts,
      timeoutMs: CLONE_TIMEOUT,
    });
    try {
      await gitIn(repoPath, ["sparse-checkout", "set", ...SPARSE_DIRS], gitOpts);
    } catch {
      // 稀疏设置失败不阻断（退化：全量工作区仍可用）
    }
  };
  // 优先按 main 克隆；远端默认分支不是 main 时退化为默认分支克隆
  try {
    await sparseClone(["--branch", "main"]);
    return "main";
  } catch (e) {
    if (!/branch|main/i.test(errMsg(e))) throw e;
    await sparseClone([]);
    try {
      const { stdout } = await gitIn(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim() || "main";
    } catch {
      return "main";
    }
  }
}

async function login(args: string, ctx: ExtensionCommandContext): Promise<void> {
  // 已有绑定：先确认是否重新绑定，取消不破坏现有配置。
  // ssh/local 远端无令牌，不能拿 hasToken 当绑定判据，改用 remoteNeedsToken 感知
  const existing = loadConfig();
  if (existing.repoUrl && (hasToken() || !remoteNeedsToken(existing.remoteKind))) {
    const again = ctx.hasUI
      ? await ctx.ui.confirm("Rebind", `Already bound to:\n${existing.repoUrl}\nRebind anyway?`)
      : false;
    if (!again) {
      ctx.ui.notify("Cancelled, keeping current binding", "info");
      return;
    }
  }

  // 1. 仓库地址：无参数时先问「有没有仓库」——普通用户首次使用没有自己的内容仓库
  let input = (args ?? "").trim();
  if (!input) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Usage: /dpi-agent-login <repo> (e.g. github.com/user/repo, git@host:user/repo.git, https://gitea.example.com/user/repo.git, ~/srv/agents.git)",
        "warning",
      );
      return;
    }
    // 首启引导：有仓库 / 没有（本地初始化）/ 没有（看模板说明）
    const HAVE_REPO = "I have a content repo URL";
    const NO_REPO_LOCAL = "No repo — initialize a local content repo here";
    const NO_REPO_TEMPLATE = "No repo — show me the starter template";
    const first = await ctx.ui.select("Do you have a content repo yet?", [
      HAVE_REPO,
      NO_REPO_LOCAL,
      NO_REPO_TEMPLATE,
    ]);
    if (first === undefined) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    if (first === NO_REPO_TEMPLATE) {
      ctx.ui.notify(
        "Fork the starter template, then run /dpi-agent-login again with your fork: https://github.com/oc101363-creator/pi-dpi/tree/main/templates/content-repo",
        "info",
      );
      return;
    }
    if (first === NO_REPO_LOCAL) {
      // 本地初始化：绑到默认 repoPath 并 bootstrap（git init，单机立即可用）
      const localPath = defaultConfig().repoPath;
      const { created } = ensureContentRepo(localPath);
      saveConfig({
        repoUrl: localPath,
        remoteKind: "local",
        repoPath: localPath,
        branch: "main",
        proxy: "",
      });
      ensurePackageInSettings(localPath);
      syncExtensionFilter(loadConfig());
      ctx.ui.notify(
        `Bound to local content repo at ${localPath}${created ? " (initialized)" : ""}. Reloading…`,
        "info",
      );
      await ctx.reload();
      return;
    }
    // 有仓库：通用 placeholder（不再暴露作者自己的仓库地址）
    input = ((await ctx.ui.input("Content repo URL", "github.com/your-name/your-agent-world")) ?? "").trim();
    if (!input) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
  }
  const remote = parseRepoRemote(input);
  if (!remote) {
    ctx.ui.notify(`Unrecognized repo address: ${input}`, "error");
    return;
  }
  const { kind, url: repoUrl } = remote;

  // 2. 通用 HTTPS 必须交互问凭证，无 UI 模式无法完成认证
  if (kind === "http" && !ctx.hasUI) {
    ctx.ui.notify(
      "Generic HTTPS remote needs interactive username + token, run /dpi-agent-login in the pi TUI",
      "error",
    );
    return;
  }

  // 3. ssh/local：零凭证也不走代理，绑定前先 ls-remote 探测可达性与仓库合法性
  if (kind === "ssh" || kind === "local") {
    if (kind === "local" && !existsSync(repoUrl)) {
      // 本地路径不存在：自动初始化最小内容仓库（bootstrap）
      const { created } = ensureContentRepo(repoUrl);
      if (created) {
        ctx.ui.notify(`Initialized minimal content repo at ${repoUrl}`, "info");
      } else {
        ctx.ui.notify(`Local path does not exist: ${repoUrl}`, "error");
        return;
      }
    } else if (kind === "local" && !existsSync(join(repoUrl, "agents"))) {
      // 存在但不是内容仓库：同样 bootstrap（不覆盖已有文件）
      const { created } = ensureContentRepo(repoUrl);
      if (created) {
        ctx.ui.notify(`Initialized minimal content repo at ${repoUrl}`, "info");
      }
    }
    try {
      await git(["ls-remote", repoUrl], { noAuth: true, timeoutMs: LS_REMOTE_TIMEOUT });
    } catch (e) {
      ctx.ui.notify(
        kind === "ssh"
          ? `Cannot reach remote via SSH, check your ssh key: ${errMsg(e)}`
          : `Not an accessible git repo: ${errMsg(e)}`,
        "error",
      );
      return;
    }
  }

  // 4. 代理选择（仅 github/http；ssh/local 跳过。无 UI 时走环境变量/直连）
  let proxy = "";
  if ((kind === "github" || kind === "http") && ctx.hasUI) {
    const NO_PROXY = "No proxy";
    const LOCAL_PROXY = "Use 127.0.0.1:7890 (local proxy)";
    const CUSTOM = "Custom…";
    const title = kind === "github" ? "Proxy for GitHub access" : "Proxy for remote repo access";
    const picked = await ctx.ui.select(title, [NO_PROXY, LOCAL_PROXY, CUSTOM]);
    if (picked === undefined) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    if (picked === LOCAL_PROXY) {
      proxy = "http://127.0.0.1:7890";
    } else if (picked === CUSTOM) {
      proxy = ((await ctx.ui.input("Proxy URL", "http://127.0.0.1:7890")) ?? "").trim();
      if (!proxy) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
    }
  }

  // 5. 认证：按类型获取并落盘凭证（ssh/local 零凭证，无落盘）
  if (kind === "github") {
    // device flow：取设备码
    let dc: DeviceCode;
    try {
      dc = await requestDeviceCode(proxy);
    } catch (e) {
      ctx.ui.notify(
        `Device code request failed: ${errMsg(e)}\nCheck network/proxy${proxy ? ` (proxy: ${proxy})` : " (no proxy)"}`,
        "error",
      );
      return;
    }

    // 展示授权码（widget 持久显示 + notify 兜底），轮询等待授权
    ctx.ui.notify(`GitHub auth: open ${dc.verification_uri}, enter code ${dc.user_code}`, "info");
    if (ctx.hasUI) {
      ctx.ui.setWidget(LOGIN_WIDGET, [
        "GitHub device authorization",
        `  1. Open in browser: ${dc.verification_uri}`,
        `  2. Enter code: ${dc.user_code}`,
        "  Waiting for authorization…",
      ]);
    }
    let token: string;
    try {
      token = await pollForToken(dc, proxy);
    } catch (e) {
      ctx.ui.notify(`Authorization incomplete: ${errMsg(e)}`, "error");
      return;
    } finally {
      clearLoginWidget(ctx);
    }
    writeToken(token);
    ctx.ui.notify("Authorized, cloning content repo…", "info");
  } else if (kind === "http") {
    // 通用 HTTPS：交互问 用户名 + 访问令牌，token 文件存两行（用户名\n令牌）
    const user = ((await ctx.ui.input("Remote username", "Gitea / GitLab / Codeberg username")) ?? "").trim();
    if (!user) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    const token = ((await ctx.ui.input("Access token / password", "Personal Access Token")) ?? "").trim();
    if (!token) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    writeToken(token, user);
    ctx.ui.notify("Credentials saved, cloning content repo…", "info");
  } else {
    ctx.ui.notify("Cloning content repo…", "info");
  }

  // 6. 克隆内容仓库（凭证已落盘，克隆失败可重跑 /agent-login 复用）
  const repoPath = defaultConfig().repoPath;
  const noAuth = kind === "ssh" || kind === "local";
  let branch: string | null;
  try {
    branch = await ensureRepo(ctx, repoUrl, repoPath, proxy, noAuth);
  } catch (e) {
    ctx.ui.notify(
      `Clone failed: ${errMsg(e)}\nCheck network/proxy and retry /dpi-agent-login`,
      "error",
    );
    return;
  }
  if (!branch) return; // 目标目录被占用的错误已提示

  // 7. 内容校验：没有 agents/*/SYSTEM.md 就不是 dpi 内容仓库——
  // 响亮报错，不写配置、不 reload（本地目录保留便于排查）
  const agents = scanAgents(repoPath);
  if (agents.length === 0) {
    ctx.ui.notify(
      `Cloned but no agents/*/SYSTEM.md found — not a dpi content repo: ${repoPath}\nLocal dir kept, check the repo address`,
      "error",
    );
    return;
  }

  // 8. 写配置；currentAgent 若在新仓库中不存在则回退到第一个可用 agent
  const patch: Record<string, unknown> = { repoUrl, remoteKind: kind, repoPath, branch, proxy };
  if (!agents.includes(existing.currentAgent)) {
    patch.currentAgent = agents[0];
  }
  saveConfig(patch);

  // 声明式关键一步：把内容包路径写进 settings.json packages，
  // 之后技能/提示词/主题由 pi 原生按包规则加载，引擎不再代劳
  const declared = ensurePackageInSettings(repoPath);

  ctx.ui.notify(
    `Bound ✓\nType: ${KIND_LABEL[kind]}\nRepo: ${repoUrl}\nLocal: ${repoPath}\nAgents: ${agents.join(", ")}${declared ? "\nDeclared as pi package (settings.json)" : ""}`,
    "info",
  );

  // 9. 重载扩展与资源，让 resources_discover 立即生效；
  // reload 前同步扩展过滤器，让内容包扩展按当前 agent 声明隔离加载
  syncExtensionFilter(loadConfig());
  try {
    await ctx.reload();
  } catch {
    // reload 失败不影响绑定结果
  }
}

export default function (pi: ExtensionAPI) {
  registerDpiCommand(pi, "dpi-agent-login", {
    description: "Bind content repo: GitHub / SSH / generic HTTPS / local (/dpi-agent-login [repo])",
    handler: async (args, ctx) => {
      try {
        await login(args, ctx);
      } catch (e) {
        clearLoginWidget(ctx);
        ctx.ui.notify(`Login failed: ${errMsg(e)}`, "error");
      }
    },
  });

  registerDpiCommand(pi, "dpi-agent-logout", {
    description: "Log out: clear local access token (repo and config kept)",
    handler: async (_args, ctx) => {
      try {
        if (!hasToken()) {
          ctx.ui.notify("Not logged in", "info");
          return;
        }
        const ok = ctx.hasUI
          ? await ctx.ui.confirm("Log out", "Clear the saved access token?\n(Local repo and config are kept, sync will stop)")
          : false;
        if (!ok) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        clearToken();
        ctx.ui.notify("Logged out: token cleared, local repo and config kept", "info");
      } catch (e) {
        ctx.ui.notify(`退出失败：${errMsg(e)}`, "error");
      }
    },
  });
}
