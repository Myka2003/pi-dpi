import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
async function ensureGatewayDirsSparse(repoPath: string): Promise<boolean> {
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
    await gitIn(repoPath, ["commit", "-m", message], opts);
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
