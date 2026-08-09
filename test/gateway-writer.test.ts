import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGatewayProfile,
  commitPushGateway,
  deleteGatewayProfile,
  writeGatewayProfile,
} from "../src/gateway-writer.ts";
import { parseGatewayProfile, scanGatewayProfiles } from "../src/gateway-profile.ts";

const dirs: string[] = [];
function tempRepo(): { work: string; bare: string } {
  const work = mkdtempSync(join(tmpdir(), "gw-work-"));
  const bare = mkdtempSync(join(tmpdir(), "gw-bare-"));
  dirs.push(work, bare);
  execFileSync("git", ["init", "-b", "main"], { cwd: work });
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: work });
  execFileSync("git", ["-C", work, "commit", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", work, "push", "-u", "origin", "main"]);
  execFileSync("mkdir", ["-p", join(work, "profiles", "gateways")]);
  return { work, bare };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gateway writer", () => {
  it("builds a valid profile that parses back", () => {
    const profile = buildGatewayProfile({
      id: "apimart",
      label: "APIMart",
      baseUrl: "https://api.apimart.ai/v1",
      credentialRef: "apimart-key",
      providerId: "apimart",
      api: "openai-completions",
      models: [{ id: "gpt-5" }, { id: "claude-opus-4-8" }],
    });
    expect(profile).not.toBeNull();
    expect(parseGatewayProfile(profile)).not.toBeNull();
  });

  it("rejects ids that fail the profile validator", () => {
    const profile = buildGatewayProfile({
      id: "Bad ID",
      label: "x",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "ref",
      providerId: "p",
      api: "openai-completions",
      models: [],
    });
    expect(profile).toBeNull();
  });

  it("writes, commits, pushes, then deletes", async () => {
    const { work } = tempRepo();
    const profile = buildGatewayProfile({
      id: "apimart",
      label: "APIMart",
      baseUrl: "https://api.apimart.ai/v1",
      credentialRef: "apimart-key",
      providerId: "apimart",
      api: "openai-completions",
      models: [{ id: "gpt-5" }],
    })!;
    expect(writeGatewayProfile(work, profile)).toBe(true);
    const result = await commitPushGateway(work, "apimart", "feat: add apimart gateway");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(scanGatewayProfiles(work).some((p) => p.id === "apimart")).toBe(true);
    const raw = readFileSync(join(work, "profiles", "gateways", "apimart.json"), "utf-8");
    expect(raw).not.toContain("sk-");
    expect(deleteGatewayProfile(work, "apimart")).toBe(true);
    expect(existsSync(join(work, "profiles", "gateways", "apimart.json"))).toBe(false);
  });

  it("reports committed=true when the commit succeeds but push fails", async () => {
    const { work } = tempRepo();
    // 把 origin 指向不存在的本地路径 → commit 成功、push 必然失败
    execFileSync("git", ["-C", work, "remote", "set-url", "origin", join(tmpdir(), "gw-remote-gone")]);
    const profile = buildGatewayProfile({
      id: "apimart",
      label: "APIMart",
      baseUrl: "https://api.apimart.ai/v1",
      credentialRef: "apimart-key",
      providerId: "apimart",
      api: "openai-completions",
      models: [{ id: "gpt-5" }],
    })!;
    expect(writeGatewayProfile(work, profile)).toBe(true);
    const result = await commitPushGateway(work, "apimart", "feat: add apimart gateway");
    // commit 已成功：committed=true，push 失败只降级 pushed 并带 error
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toBeTruthy();
    expect(scanGatewayProfiles(work).some((p) => p.id === "apimart")).toBe(true);
  });

  it("adds profiles to sparse-checkout when missing so writes still commit and push", async () => {
    const { work } = tempRepo();
    // 稀疏检出只含 agents/，profiles/ 不在其中 → git add 会被 pathspec 拒绝
    execFileSync("git", ["-C", work, "sparse-checkout", "init", "--cone"]);
    execFileSync("git", ["-C", work, "sparse-checkout", "set", "agents"]);
    const profile = buildGatewayProfile({
      id: "apimart",
      label: "APIMart",
      baseUrl: "https://api.apimart.ai/v1",
      credentialRef: "apimart-key",
      providerId: "apimart",
      api: "openai-completions",
      models: [{ id: "gpt-5" }],
    })!;
    expect(writeGatewayProfile(work, profile)).toBe(true);
    const result = await commitPushGateway(work, "apimart", "feat: add apimart gateway");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    const list = execFileSync("git", ["-C", work, "sparse-checkout", "list"], {
      encoding: "utf-8",
    });
    expect(list).toContain("profiles");
  });
});
