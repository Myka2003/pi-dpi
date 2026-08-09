import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addModelsToProvider,
  addProviderToGateway,
  buildGatewayProfile,
  commitPushGateway,
  deleteGatewayProfile,
  ensureGatewayDirsSparse,
  removeModel,
  removeProvider,
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
  // init 提交带显式身份：不依赖机器 git config，保证无身份环境下测试可复现
  execFileSync(
    "git",
    [
      "-C",
      work,
      "-c",
      "user.name=dpi",
      "-c",
      "user.email=dpi@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
  );
  execFileSync("git", ["-C", work, "push", "-u", "origin", "main"]);
  execFileSync("mkdir", ["-p", join(work, "profiles", "gateways")]);
  return { work, bare };
}

/** 最近一次提交的作者（%an <%ae>） */
function commitAuthor(repoPath: string): string {
  return execFileSync("git", ["-C", repoPath, "log", "-1", "--format=%an <%ae>"], {
    encoding: "utf-8",
  }).trim();
}

/** 临时屏蔽全局/系统 git 身份，让「未配置身份」用例在任意机器上可复现 */
async function withoutGlobalIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return await fn();
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gateway provider/model management", () => {
  it("adds a provider, adds models, removes model, removes provider — all committed+pushed", async () => {
    const { work } = tempRepo();
    const base = buildGatewayProfile({
      id: "gw",
      label: "GW",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "k",
      providerId: "p1",
      api: "openai-completions",
      models: [{ id: "a" }],
    })!;
    writeGatewayProfile(work, base);
    await commitPushGateway(work, "gw", "init");

    let r = await addProviderToGateway(
      work,
      "gw",
      { id: "p2", name: "P2", api: "openai-completions", models: [{ id: "b" }, { id: "c" }] },
      "add p2",
    );
    expect(r.ok).toBe(true);
    expect(scanGatewayProfiles(work)[0].providers.map((p) => p.id)).toContain("p2");

    r = await addModelsToProvider(work, "gw", "p2", [{ id: "d" }], "add d");
    expect(r.ok).toBe(true);
    const p2 = scanGatewayProfiles(work)[0].providers.find((p) => p.id === "p2")!;
    expect(p2.models.map((m) => m.id)).toEqual(["b", "c", "d"]);

    r = await removeModel(work, "gw", "p2", "c", "rm c");
    expect(r.ok).toBe(true);
    expect(
      scanGatewayProfiles(work)[0].providers.find((p) => p.id === "p2")!.models.map((m) => m.id),
    ).toEqual(["b", "d"]);

    r = await removeProvider(work, "gw", "p2", "rm p2");
    expect(r.ok).toBe(true);
    expect(scanGatewayProfiles(work)[0].providers.map((p) => p.id)).toEqual(["p1"]);
  });

  it("returns ok:false without throwing when the provider already exists", async () => {
    const { work } = tempRepo();
    const base = buildGatewayProfile({
      id: "gw",
      label: "GW",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "k",
      providerId: "p1",
      api: "openai-completions",
      models: [{ id: "a" }],
    })!;
    writeGatewayProfile(work, base);
    await commitPushGateway(work, "gw", "init");

    const r = await addProviderToGateway(
      work,
      "gw",
      { id: "p1", api: "openai-completions", models: [{ id: "x" }] },
      "dup p1",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exists");
    // 未发生任何写入/提交
    expect(scanGatewayProfiles(work)[0].providers.map((p) => p.id)).toEqual(["p1"]);
  });

  it("returns ok:false without throwing for a missing provider on addModels/removeModel", async () => {
    const { work } = tempRepo();
    const base = buildGatewayProfile({
      id: "gw",
      label: "GW",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "k",
      providerId: "p1",
      api: "openai-completions",
      models: [{ id: "a" }],
    })!;
    writeGatewayProfile(work, base);
    await commitPushGateway(work, "gw", "init");

    const r1 = await addModelsToProvider(work, "gw", "nope", [{ id: "x" }], "add to nope");
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("missing");

    const r2 = await removeModel(work, "gw", "nope", "a", "rm from nope");
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("missing");
  });
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

  it("commits with the dpi fallback identity when none is configured", async () => {
    await withoutGlobalIdentity(async () => {
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
      expect(commitAuthor(work)).toBe("dpi <dpi@users.noreply.github.com>");
    });
  });

  it("keeps the repo's configured identity for commits", async () => {
    const { work } = tempRepo();
    execFileSync("git", ["-C", work, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
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
    expect(commitAuthor(work)).toBe("Test User <test@example.com>");
  });

  it("deletes a tracked profile on a sparse-missing-profiles repo without resurrecting it", async () => {
    const { work } = tempRepo();
    // 全量工作区提交 profile，使其进入 index 与远端
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
    const added = await commitPushGateway(work, "apimart", "feat: add apimart gateway");
    expect(added.committed).toBe(true);
    expect(added.pushed).toBe(true);
    expect(existsSync(join(work, "profiles", "gateways", "apimart.json"))).toBe(true);

    // 收紧稀疏集为 agents only → 文件从工作区剪除但仍被 index 跟踪
    execFileSync("git", ["-C", work, "sparse-checkout", "init", "--cone"]);
    execFileSync("git", ["-C", work, "sparse-checkout", "set", "agents"]);
    expect(existsSync(join(work, "profiles", "gateways", "apimart.json"))).toBe(false);
    expect(
      execFileSync("git", ["-C", work, "ls-files", "profiles/gateways/apimart.json"], {
        encoding: "utf-8",
      }).trim(),
    ).toBe("profiles/gateways/apimart.json");

    // 删除流程：先确保 profiles 在稀疏集内，再删文件，最后提交推送
    expect(await ensureGatewayDirsSparse(work)).toBe(true);
    expect(deleteGatewayProfile(work, "apimart")).toBe(true);
    const result = await commitPushGateway(work, "apimart", "chore: remove gateway apimart");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    // 文件保持删除（不被稀疏集补回），且存在删除提交
    expect(existsSync(join(work, "profiles", "gateways", "apimart.json"))).toBe(false);
    expect(scanGatewayProfiles(work).some((p) => p.id === "apimart")).toBe(false);
    const removalLog = execFileSync(
      "git",
      ["-C", work, "log", "--diff-filter=D", "--oneline", "--", "profiles/gateways/apimart.json"],
      { encoding: "utf-8" },
    );
    expect(removalLog).toContain("chore: remove gateway apimart");
  });
});
