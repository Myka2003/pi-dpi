import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCredentialRef, type GatewayProfile } from "./gateway-profile.ts";

const run = promisify(execFile);

export interface GatewayHealthReport {
  ok: boolean;
  credential: "resolved" | "missing";
  endpoint: "reachable" | "unreachable" | "unchecked";
  models: number;
  providers: number;
  latencyMs?: number;
  issues: string[];
}

async function resolveSecret(command: string): Promise<string> {
  const { stdout } = await run("/bin/sh", ["-lc", command], { timeout: 8000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function checkGatewayHealth(
  profile: GatewayProfile,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayHealthReport> {
  const issues: string[] = [];
  const providers = profile.providers.length;
  const fetchImpl = options.fetchImpl ?? fetch;
  const credential = resolveCredentialRef(profile.credentialRef);
  if (credential.kind === "missing") {
    return { ok: false, credential: "missing", endpoint: "unchecked", models: 0, providers, issues: [credential.reason] };
  }

  let token = "";
  try {
    token = await resolveSecret(credential.value);
  } catch {
    return { ok: false, credential: "missing", endpoint: "unchecked", models: 0, providers, issues: [`credential command failed: ${profile.credentialRef}`] };
  }

  const started = Date.now();
  try {
    const response = await fetchImpl(`${profile.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { data?: unknown[] };
    const models = Array.isArray(payload.data) ? payload.data.length : 0;
    if (models === 0) issues.push("/models returned an empty catalog");
    return {
      ok: issues.length === 0,
      credential: "resolved",
      endpoint: "reachable",
      models,
      providers,
      latencyMs: Date.now() - started,
      issues,
    };
  } catch (error) {
    return {
      ok: false,
      credential: "resolved",
      endpoint: "unreachable",
      models: 0,
      providers,
      latencyMs: Date.now() - started,
      issues: [`/models failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
