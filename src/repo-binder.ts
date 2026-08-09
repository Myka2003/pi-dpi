import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "./config.ts";
import { git, gitIn } from "./git.ts";
import { writeCredential } from "./credential-store.ts";

const SPARSE_DIRS = ["agents", "extensions", "skills", "docs", "profiles", "machines"];

export async function bindRepoWithKey(
  repoUrl: string,
  key: string,
  options: { home?: string; repoPath?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const home = options.home ?? homedir();
  const repoPath = options.repoPath ?? join(home, ".pi", "agent", "dpi", "repo");
  const sshDir = join(home, ".ssh");
  const configDir = join(sshDir, "config.d");
  try {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const keyFile = join(sshDir, "dpi_agent_ed25519");
    writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    writeFileSync(
      join(configDir, "dpi-agent-repo"),
      `Host github.com-dpi-agent\n  HostName github.com\n  User git\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n`,
      { mode: 0o600 },
    );
    if (!existsSync(join(sshDir, "config"))) {
      writeFileSync(join(sshDir, "config"), `Include ~/.ssh/config.d/*\n`, { mode: 0o600 });
    }
    writeCredential("dpi-agent-repo-key", key);
    saveConfig({ repoUrl, repoPath, branch: "main" });
    try {
      await git(["clone", "--filter=blob:none", "--sparse", repoUrl, repoPath], {
        noAuth: true,
        timeoutMs: 120000,
      });
      await gitIn(
        repoPath,
        ["sparse-checkout", "set", ...SPARSE_DIRS],
        { noAuth: true, timeoutMs: 30000 },
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `clone failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  } catch (e) {
    return { ok: false, error: `setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
