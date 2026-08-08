import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRepo, repairRepo } from "../src/repo-doctor.ts";
import { saveConfig } from "../src/config.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dpi-repo-doctor-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repo doctor", () => {
  it("diagnoses and repairs a wrong remote without recloning", async () => {
    const agentDir = tempDir();
    const repo = tempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/wrong.git"], { cwd: repo });
    saveConfig({ repoUrl: "git@github.com-dpi-agent:Myka2003/Agent.git", repoPath: repo, branch: "main" });

    const before = await inspectRepo({ network: false });
    expect(before.ok).toBe(false);
    expect(before.issues.join("\n")).toContain("remote mismatch");

    const after = await repairRepo();
    expect(after.remoteUrl).toBe("git@github.com-dpi-agent:Myka2003/Agent.git");
  });
});
