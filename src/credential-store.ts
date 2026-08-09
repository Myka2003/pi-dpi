import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REF_RE = /^[a-z0-9][a-z0-9-]*$/;

export function credentialDir(): string {
  return join(homedir(), ".config", "dpi", "credentials");
}

export function validateRef(ref: string): boolean {
  return REF_RE.test(ref);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function writeCredential(ref: string, key: string): boolean {
  if (!validateRef(ref) || key === "") return false;
  try {
    mkdirSync(credentialDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(credentialDir(), ref), `!printf %s ${shellQuote(key)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function readCredential(ref: string): string | null {
  if (!validateRef(ref)) return null;
  try {
    const line = readFileSync(join(credentialDir(), ref), "utf-8").trim();
    const m = /^!printf %s (.+)$/.exec(line);
    if (!m) return null;
    const raw = m[1];
    if (raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1).replace(/'\\''/g, "'");
    }
    return raw;
  } catch {
    return null;
  }
}

export function deleteCredential(ref: string): void {
  if (!validateRef(ref)) return;
  try {
    rmSync(join(credentialDir(), ref), { force: true });
  } catch {
    // 删除失败不抛
  }
}
