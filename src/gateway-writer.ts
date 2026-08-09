import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitAuthOpts, loadConfig } from "./config.ts";
import { gitIn, type GitOptions } from "./git.ts";
import { parseGatewayProfile, type GatewayModel, type GatewayProfile } from "./gateway-profile.ts";

export interface AddGatewayInput {
  id: string;
  label: string;
  baseUrl: string;
  credentialRef: string;
  apiKey?: string; // schema 2：key 直接入库（提供时写 schema 2 profile）
  providerId: string;
  api: GatewayProfile["providers"][number]["api"];
  models: GatewayModel[];
}

export function buildGatewayProfile(input: AddGatewayInput): GatewayProfile | null {
  // schema 2：apiKey 直接写进 profile（私有仓库即安全边界）；无 apiKey 时保持
  // schema 1 的 credentialRef 旧格式（兼容）。
  const profile: GatewayProfile = input.apiKey
    ? {
        schema: 2,
        id: input.id,
        label: input.label,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        providers: [
          {
            id: input.providerId,
            name: input.label,
            api: input.api,
            models: input.models,
          },
        ],
      }
    : {
        schema: 1,
        id: input.id,
        label: input.label,
        baseUrl: input.baseUrl,
        credentialRef: input.credentialRef,
        providers: [
          {
            id: input.providerId,
            name: input.label,
            api: input.api,
            models: input.models,
          },
        ],
      };
  return parseGatewayProfile(profile);
}

export function writeGatewayProfile(repoPath: string, profile: GatewayProfile): boolean {
  try {
    const dir = join(repoPath, "profiles", "gateways");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${profile.id}.json`), `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o644,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保稀疏检出包含 profiles/：非稀疏仓库（sparse-checkout list 报 "not sparse"）
 * 或已含 profiles 时直接放行；稀疏仓库缺 profiles 时执行 sparse-checkout add profiles。
 * 返回 false 仅表示稀疏仓库下 add profiles 失败。
 */
export async function ensureGatewayDirsSparse(repoPath: string): Promise<boolean> {
  const opts = { noAuth: true };
  let list: string;
  try {
    ({ stdout: list } = await gitIn(repoPath, ["sparse-checkout", "list"], opts));
  } catch {
    // 非稀疏仓库：sparse-checkout list 报 "not sparse"，工作区完整，无需调整
    return true;
  }
  // 空输出（旧版 git 对非稀疏仓库输出为空）或已含 profiles：无需调整
  if (list.trim().length === 0 || list.includes("profiles")) return true;
  try {
    await gitIn(repoPath, ["sparse-checkout", "add", "profiles"], opts);
    return true;
  } catch {
    return false;
  }
}

/** 提交身份兜底：机器未配置 user.name/user.email 时用 dpi 默认身份，
 * 否则返回空数组尊重仓库既有配置。返回可直接拼入 commit 命令的 -c 参数。 */
async function commitIdentityArgs(repoPath: string): Promise<string[]> {
  const opts = { noAuth: true };
  let name = "";
  let email = "";
  try {
    ({ stdout: name } = await gitIn(repoPath, ["config", "user.name"], opts));
  } catch {
    // 未配置 user.name：走默认身份
  }
  try {
    ({ stdout: email } = await gitIn(repoPath, ["config", "user.email"], opts));
  } catch {
    // 未配置 user.email：走默认身份
  }
  const args: string[] = [];
  if (!name.trim()) args.push("-c", "user.name=dpi");
  if (!email.trim()) args.push("-c", "user.email=dpi@users.noreply.github.com");
  return args;
}

/**
 * push-with-retry：首次 push 失败（典型场景：共享仓库上远端已前进，本机提交
 * non-fast-forward 被拒）时，pull --rebase --autostash 吸收远端提交后重试 push
 * 一次；pull/rebase 抛出（冲突）则 rebase --abort 恢复一致，返回可恢复错误信息
 * （交用户跑 /dpi-sync 解决）。
 */
async function pushWithRebaseRetry(
  repoPath: string,
  pushOpts: GitOptions,
): Promise<{ pushed: boolean; error?: string }> {
  const branch = loadConfig().branch || "main";
  try {
    await gitIn(repoPath, ["push"], pushOpts);
    return { pushed: true };
  } catch (error) {
    try {
      await gitIn(repoPath, ["pull", "--rebase", "--autostash", "origin", branch], pushOpts);
    } catch {
      // rebase 冲突（或 pull 因别的原因失败）：abort 保持仓库一致
      try {
        await gitIn(repoPath, ["rebase", "--abort"], { noAuth: true });
      } catch {
        // abort 失败（如本就没有 rebase 在进行）不覆盖主错误
      }
      return {
        pushed: false,
        error: "push failed: remote moved and rebase conflicted; run /dpi-sync to resolve",
      };
    }
    // pull --rebase 成功：重试 push 一次
    try {
      await gitIn(repoPath, ["push"], pushOpts);
      return { pushed: true };
    } catch (error) {
      return {
        pushed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export async function commitPushGateway(
  repoPath: string,
  profileId: string,
  message: string,
): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
  if (!(await ensureGatewayDirsSparse(repoPath))) {
    return {
      committed: false,
      pushed: false,
      error: "failed to add profiles/ to sparse-checkout",
    };
  }
  const opts = gitAuthOpts(15000);
  try {
    const file = `profiles/gateways/${profileId}.json`;
    await gitIn(repoPath, ["add", file], opts);
    const { stdout } = await gitIn(repoPath, ["status", "--porcelain", "--", file], opts);
    if (stdout.trim().length === 0) return { committed: false, pushed: false };
    const identityArgs = await commitIdentityArgs(repoPath);
    // -- <file> 把提交范围限定为目标 profile：即使 index 中还有别的已暂存文件
    // （如 dpi-sync 暂存的 session blob），也只提交该 profile，避免大文件误入提交。
    await gitIn(repoPath, [...identityArgs, "commit", "-m", message, "--", file], opts);
  } catch (error) {
    return {
      committed: false,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // commit 已成功：committed=true 立即成立；push 失败先 pull --rebase 吸收远端
  // 提交再重试一次，仍失败只降级 pushed
  const pushOpts = { ...opts, timeoutMs: 60000 };
  const r = await pushWithRebaseRetry(repoPath, pushOpts);
  return r.pushed
    ? { committed: true, pushed: true }
    : { committed: true, pushed: false, error: r.error };
}

export function deleteGatewayProfile(repoPath: string, profileId: string): boolean {
  try {
    rmSync(join(repoPath, "profiles", "gateways", `${profileId}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 供应商 / 模型管理（0.8.43）：读 profile → 改 providers/models → parseGatewayProfile
// 校验 → 写回 → ensureGatewayDirsSparse + commitPushGateway。失败返回
// { ok:false, error }，绝不抛出（mutate 内的校验错误由 catch 统一转换）。
// ---------------------------------------------------------------------------

export interface AddProviderInput {
  id: string;
  name?: string;
  api: GatewayProfile["providers"][number]["api"];
  baseUrl?: string; // schema 2：provider 级上游地址
  apiKey?: string; // schema 2：provider 级 key（直接入库）
  models: GatewayModel[];
}

type MutateResult = { ok: boolean; error?: string };

async function mutateGatewayProfile(
  repoPath: string,
  gatewayId: string,
  message: string,
  mutate: (p: GatewayProfile) => void,
): Promise<MutateResult> {
  const file = join(repoPath, "profiles", "gateways", `${gatewayId}.json`);
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const profile = parseGatewayProfile(raw);
    if (!profile) return { ok: false, error: "profile invalid" };
    mutate(profile);
    if (!parseGatewayProfile(profile)) return { ok: false, error: "mutated profile invalid" };
    writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o644 });
    if (!(await ensureGatewayDirsSparse(repoPath))) return { ok: false, error: "sparse ensure failed" };
    const r = await commitPushGateway(repoPath, gatewayId, message);
    return { ok: r.committed && r.pushed, error: r.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 新增供应商：id 冲突时失败；成功写回并 commit+push。provider 携带 schema 2
 * 字段（baseUrl/apiKey）时把旧 schema 1 profile 自动提升为 schema 2（既有
 * credentialRef 保留供兼容）。 */
export async function addProviderToGateway(
  repoPath: string,
  gatewayId: string,
  provider: AddProviderInput,
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    if (p.providers.some((x) => x.id === provider.id)) throw new Error(`provider exists: ${provider.id}`);
    p.providers.push(provider);
    if (p.schema === 1 && (provider.baseUrl !== undefined || provider.apiKey !== undefined)) {
      (p as GatewayProfile).schema = 2;
    }
  });
}

/** 追加模型到供应商（已存在同 id 的模型跳过）；成功写回并 commit+push */
export async function addModelsToProvider(
  repoPath: string,
  gatewayId: string,
  providerId: string,
  models: GatewayModel[],
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    const prov = p.providers.find((x) => x.id === providerId);
    if (!prov) throw new Error(`provider missing: ${providerId}`);
    for (const m of models) if (!prov.models.some((x) => x.id === m.id)) prov.models.push(m);
  });
}

/** 删除供应商（目标不存在返回 { ok:false, error:"provider missing: X" }，绝不静默
 * no-op 提交）；成功写回并 commit+push */
export async function removeProvider(
  repoPath: string,
  gatewayId: string,
  providerId: string,
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    if (!p.providers.some((x) => x.id === providerId)) {
      throw new Error(`provider missing: ${providerId}`);
    }
    p.providers = p.providers.filter((x) => x.id !== providerId);
  });
}

/** 删除供应商下的单个模型（供应商缺失报 provider missing、模型缺失报
 * model missing，返回 { ok:false, error }，绝不静默 no-op 提交）；成功写回并 commit+push */
export async function removeModel(
  repoPath: string,
  gatewayId: string,
  providerId: string,
  modelId: string,
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    const prov = p.providers.find((x) => x.id === providerId);
    if (!prov) throw new Error(`provider missing: ${providerId}`);
    if (!prov.models.some((x) => x.id === modelId)) {
      throw new Error(`model missing: ${modelId}`);
    }
    prov.models = prov.models.filter((x) => x.id !== modelId);
  });
}
