import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, saveConfig } from "../src/config.ts";

const dirs: string[] = [];
function useTempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dpi-config-persistence-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dpi config persistence", () => {
  it("preserves unknown fields and writes schema", () => {
    useTempAgentDir();
    saveConfig({ repoUrl: "/tmp/repo", currentGateway: "ser7-cpa" });
    const file = configPath();
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    raw.customFutureField = { enabled: true };
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");

    saveConfig({ currentAgent: "coder" });
    const next = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(next.schema).toBe(1);
    expect(next.customFutureField).toEqual({ enabled: true });
    expect(next.currentGateway).toBe("ser7-cpa");
  });

  it("does not clear an effective string unless allowEmpty is true", () => {
    useTempAgentDir();
    saveConfig({ repoUrl: "/tmp/repo", currentGateway: "ser7-cpa" });
    saveConfig({ currentGateway: "" });
    expect(loadConfig().currentGateway).toBe("ser7-cpa");
    saveConfig({ currentGateway: "" }, { allowEmpty: true });
    expect(loadConfig().currentGateway).toBe("");
  });

  it("keeps a backup and recovers from corrupt config", () => {
    useTempAgentDir();
    saveConfig({ repoUrl: "/tmp/repo", currentGateway: "ser7-cpa" });
    writeFileSync(configPath(), "{broken\n", "utf-8");
    expect(loadConfig().currentGateway).toBe("ser7-cpa");
  });

  it("clears a stale proxy on local-repo init (explicit allowEmpty clear path)", () => {
    useTempAgentDir();
    saveConfig({ repoUrl: "/tmp/repo", remoteKind: "github", proxy: "http://127.0.0.1:7890" });
    // 对应 dpi-auth 本地初始化路径：proxy: "" + allowEmpty: true 显式清除
    saveConfig(
      {
        repoUrl: "/tmp/local-repo",
        remoteKind: "local",
        repoPath: "/tmp/local-repo",
        branch: "main",
        proxy: "",
      },
      { allowEmpty: true },
    );
    expect(loadConfig().proxy).toBe("");
  });

  it("clears a stale proxy on re-login with No proxy, and preserves it otherwise", () => {
    useTempAgentDir();
    saveConfig({ repoUrl: "/tmp/repo", remoteKind: "github", proxy: "http://127.0.0.1:7890" });
    // 普通 saveConfig 空串不生效：已有有效代理不被误清
    saveConfig({ proxy: "" });
    expect(loadConfig().proxy).toBe("http://127.0.0.1:7890");
    // 对应 dpi-auth 登录“No proxy”路径：显式清除
    saveConfig({ proxy: "" }, { allowEmpty: true });
    expect(loadConfig().proxy).toBe("");
  });
});
