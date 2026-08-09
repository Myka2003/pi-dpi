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
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    credentialDir?: string;
    apiKey?: string; // schema 2：显式直用 key
  } = {},
): Promise<GatewayHealthReport> {
  const issues: string[] = [];
  const providers = profile.providers.length;
  const fetchImpl = options.fetchImpl ?? fetch;
  const directKey = options.apiKey ?? profile.apiKey; // 显式参数优先，其次 profile 级聚合 key
  let token = "";
  if (typeof directKey === "string" && directKey !== "") {
    token = directKey;
  } else if (typeof profile.credentialRef === "string" && profile.credentialRef !== "") {
    const credential = resolveCredentialRef(profile.credentialRef, options.env, options.credentialDir);
    if (credential.kind === "missing") {
      return { ok: false, credential: "missing", endpoint: "unchecked", models: 0, providers, issues: [credential.reason] };
    }
    try {
      token = await resolveSecret(credential.value);
    } catch {
      return { ok: false, credential: "missing", endpoint: "unchecked", models: 0, providers, issues: [`credential command failed: ${profile.credentialRef}`] };
    }
  } else {
    // schema 2 无任何 key：credentialRef 缺失不再报错（不崩溃），如实报告 missing
    return {
      ok: false,
      credential: "missing",
      endpoint: "unchecked",
      models: 0,
      providers,
      issues: ["no apiKey or credentialRef configured"],
    };
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
