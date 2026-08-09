import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitAuthOpts } from "./config.ts";
import { gitIn } from "./git.ts";
import { parseGatewayProfile, type GatewayModel, type GatewayProfile } from "./gateway-profile.ts";

export interface AddGatewayInput {
  id: string;
  label: string;
  baseUrl: string;
  credentialRef: string;
  providerId: string;
  api: GatewayProfile["providers"][number]["api"];
  models: GatewayModel[];
}

export function buildGatewayProfile(input: AddGatewayInput): GatewayProfile | null {
  const profile: GatewayProfile = {
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
    await gitIn(repoPath, [...identityArgs, "commit", "-m", message], opts);
  } catch (error) {
    return {
      committed: false,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // commit 已成功：committed=true 立即成立；push 失败只降级 pushed
  try {
    await gitIn(repoPath, ["push"], { ...opts, timeoutMs: 60000 });
    return { committed: true, pushed: true };
  } catch (error) {
    return {
      committed: true,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

/** 新增供应商：id 冲突时失败；成功写回并 commit+push */
export async function addProviderToGateway(
  repoPath: string,
  gatewayId: string,
  provider: AddProviderInput,
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    if (p.providers.some((x) => x.id === provider.id)) throw new Error(`provider exists: ${provider.id}`);
    p.providers.push(provider);
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

/** 删除供应商（不存在则静默 no-op 仍提交）；成功写回并 commit+push */
export async function removeProvider(
  repoPath: string,
  gatewayId: string,
  providerId: string,
  message: string,
): Promise<MutateResult> {
  return mutateGatewayProfile(repoPath, gatewayId, message, (p) => {
    p.providers = p.providers.filter((x) => x.id !== providerId);
  });
}

/** 删除供应商下的单个模型（供应商缺失报错）；成功写回并 commit+push */
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
    prov.models = prov.models.filter((x) => x.id !== modelId);
  });
}
