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

export async function commitPushGateway(
  repoPath: string,
  profileId: string,
  message: string,
): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
  const opts = gitAuthOpts(15000);
  try {
    const file = `profiles/gateways/${profileId}.json`;
    await gitIn(repoPath, ["add", file], opts);
    const { stdout } = await gitIn(repoPath, ["status", "--porcelain", "--", file], opts);
    if (stdout.trim().length === 0) return { committed: false, pushed: false };
    await gitIn(repoPath, ["commit", "-m", message], opts);
    await gitIn(repoPath, ["push"], { ...opts, timeoutMs: 60000 });
    return { committed: true, pushed: true };
  } catch (error) {
    return {
      committed: false,
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
