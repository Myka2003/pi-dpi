import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAuthArgs } from "../src/git.ts";
import { safeAgentName, scanManifestAgents } from "../src/common.ts";

describe("gitAuthArgs credential helper", () => {
  it("单行 token（GitHub 旧格式）走 x-access-token 分支（helper 运行期 sed 读文件）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_abc\n", "utf-8");
    const args = gitAuthArgs(tokenFile);
    // 辅助函数以 git -c 参数形式注入：先清空外部 helper
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe("credential.helper=");
    const joined = args.join(" ");
    // helper 脚本引用 token 文件并在运行期读取：单行分支输出 x-access-token
    expect(joined).toContain(`sed -n 1p "${tokenFile}"`);
    expect(joined).toContain('echo username=x-access-token');
    expect(joined).toContain('echo "password=$L1"');
    expect(joined).not.toContain("ghp_abc"); // token 值绝不落进命令行
    rmSync(dir, { recursive: true });
  });

  it("两行 token（通用 HTTPS：用户名\\n令牌）走逐行输出分支", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "gitea-user\ntoken123\n", "utf-8");
    const joined = gitAuthArgs(tokenFile).join(" ");
    expect(joined).toContain('echo "username=$L1"');
    expect(joined).toContain('echo "password=$L2"');
    expect(joined).not.toContain("gitea-user"); // 凭证值绝不落进命令行
    expect(joined).not.toContain("token123");
    rmSync(dir, { recursive: true });
  });
});

describe("safeAgentName 白名单", () => {
  it("合法名字原样返回，非法回退 coder", () => {
    expect(safeAgentName("coder")).toBe("coder");
    expect(safeAgentName("my-agent_2")).toBe("my-agent_2");
    expect(safeAgentName("../../etc")).toBe("coder");
    expect(safeAgentName("a/b")).toBe("coder");
    expect(safeAgentName("")).toBe("coder");
  });
});

describe("scanManifestAgents", () => {
  it("只返回含 agent.json 的子目录，白名单过滤", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const agents = join(dir, "agents");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(agents, "coder"), { recursive: true });
    mkdirSync(join(agents, "writer"), { recursive: true });
    mkdirSync(join(agents, "no-manifest"), { recursive: true });
    writeFileSync(join(agents, "coder", "agent.json"), "{}");
    writeFileSync(join(agents, "writer", "agent.json"), "{}");
    writeFileSync(join(agents, "no-manifest", "SYSTEM.md"), "# x");
    // scanManifestAgents 接收仓库根，内部拼 agents/ 子目录
    expect(scanManifestAgents(dir)).toEqual(["coder", "writer"]);
    rmSync(dir, { recursive: true });
  });

  it("目录不存在返回空数组", () => {
    expect(scanManifestAgents("/nonexistent/repo")).toEqual([]);
  });
});

describe("syncStrictSkills（settings 写入）", () => {
  it("通过环境变量指向的 agentDir 写入 skills=[\"!*\"] 且幂等", () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ packages: [] }), "utf-8");
    process.env.PI_CODING_AGENT_DIR = dir;
    const { syncStrictSkills } = require("../src/config.ts") as typeof import("../src/config.ts");
    expect(syncStrictSkills()).toBe(true); // 首次写入
    expect(syncStrictSkills()).toBe(false); // 幂等
    const raw = JSON.parse(readFileSync(settings, "utf-8"));
    expect(raw.skills).toEqual(["!*"]);
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true });
  });
});
