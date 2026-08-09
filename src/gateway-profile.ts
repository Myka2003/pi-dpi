import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";

export interface GatewayModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface GatewayProvider {
  id: string;
  name?: string;
  api: string;
  compat?: Record<string, unknown>;
  models: GatewayModel[];
}

export interface GatewayProfile {
  schema: 1;
  id: string;
  label?: string;
  baseUrl: string;
  credentialRef: string;
  providers: GatewayProvider[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SENSITIVE_KEY_RE = /(?:^|[-_])(api[-_]?key|token|secret|password|oauth|private[-_]?key|credential[-_]?value)(?:$|[-_])/i;
const ALLOWED_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSensitiveKey(value: unknown, root = true): boolean {
  if (Array.isArray(value)) return value.some((item) => hasSensitiveKey(item, false));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (!(root && key === "credentialRef") && SENSITIVE_KEY_RE.test(key)) return true;
    return hasSensitiveKey(child, false);
  });
}

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "/v1") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    return host.includes(".") || /^[0-9a-f:]+$/i.test(host);
  } catch {
    return false;
  }
}

function validModel(value: unknown): value is GatewayModel {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") return false;
  if (value.input !== undefined && (!Array.isArray(value.input) || value.input.some((item) => item !== "text" && item !== "image"))) return false;
  if (value.contextWindow !== undefined && (typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0)) return false;
  if (value.maxTokens !== undefined && (typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0)) return false;
  if (value.cost !== undefined && !isRecord(value.cost)) return false;
  if (value.compat !== undefined && !isRecord(value.compat)) return false;
  if (value.thinkingLevelMap !== undefined && !isRecord(value.thinkingLevelMap)) return false;
  return true;
}

function validProvider(value: unknown): value is GatewayProvider {
  if (!isRecord(value) || typeof value.id !== "string" || !ID_RE.test(value.id)) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (typeof value.api !== "string" || !ALLOWED_APIS.has(value.api)) return false;
  if (value.compat !== undefined && !isRecord(value.compat)) return false;
  return Array.isArray(value.models) && value.models.every(validModel);
}

export function parseGatewayProfile(raw: unknown): GatewayProfile | null {
  if (!isRecord(raw) || hasSensitiveKey(raw)) return null;
  if (raw.schema !== 1 || typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  if (raw.label !== undefined && typeof raw.label !== "string") return null;
  if (!validBaseUrl(raw.baseUrl)) return null;
  if (typeof raw.credentialRef !== "string" || !ID_RE.test(raw.credentialRef)) return null;
  if (!Array.isArray(raw.providers) || raw.providers.length === 0 || !raw.providers.every(validProvider)) return null;
  return raw as unknown as GatewayProfile;
}

export function scanGatewayProfiles(repoPath: string): GatewayProfile[] {
  try {
    const root = realpathSync(join(repoPath, "profiles", "gateways"));
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const file = join(root, entry.name);
          if (lstatSync(file).isSymbolicLink()) return [];
          const resolved = realpathSync(file);
          const rel = relative(root, resolved);
          if (rel.startsWith("..") || rel.includes("/")) return [];
          return [parseGatewayProfile(JSON.parse(readFileSync(file, "utf-8")))].filter(
            (profile): profile is GatewayProfile => profile !== null,
          );
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function credentialEnvName(ref: string): string {
  return `DPI_CREDENTIAL_REF_${ref.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

export type CredentialResolution =
  | { kind: "command"; value: string }
  | { kind: "missing"; reason: string };

function normalizeCredentialCommand(command: string, ref: string): CredentialResolution {
  const trimmed = command.trim();
  if (trimmed === "" || !trimmed.startsWith("!") || trimmed.slice(1).trim() === "") {
    return { kind: "missing", reason: `credential reference is not command-backed: ${ref}` };
  }
  return { kind: "command", value: trimmed.slice(1).trim() };
}

export function resolveCredentialRef(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
  credentialDir: string = join(homedir(), ".config", "dpi", "credentials"),
): CredentialResolution {
  const value = env[credentialEnvName(ref)];
  if (typeof value === "string" && value.trim() !== "") {
    return normalizeCredentialCommand(value, ref);
  }
  // Fallback: user credential command file (0600) in credentialDir/<ref>.
  try {
    const fileValue = readFileSync(join(credentialDir, ref), "utf-8");
    return normalizeCredentialCommand(fileValue, ref);
  } catch {
    return { kind: "missing", reason: `credential reference unavailable: ${ref}` };
  }
}
