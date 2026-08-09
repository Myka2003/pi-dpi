import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindRepoWithKey } from "../src/repo-binder.ts";

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.HOME;
});

describe("repo binder", () => {
  it("writes key 0600 and ssh config, then saves config binding", async () => {
    root = mkdtempSync(join(tmpdir(), "dpi-bind-"));
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
    // 克隆目标用本地已关闭端口（127.0.0.1:1）→ Connection refused 立即失败，
    // 离线可复现且不依赖网络；原 github.com 地址会因本机 ssh 走 passwd home 的真实 key 认证成功而无法制造失败。
    const result = await bindRepoWithKey("ssh://git@127.0.0.1:1/foo/bar.git", "PRIVATE_KEY\n", {
      home: root,
      repoPath: join(root, "repo"),
    });
    // clone 会失败（连接被拒），但我们验证 key/config 已落地且失败不抛
    expect(existsSync(join(root, ".ssh", "dpi_agent_ed25519"))).toBe(true);
    expect(statSync(join(root, ".ssh", "dpi_agent_ed25519")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, ".ssh", "config.d", "dpi-agent-repo"), "utf-8")).toContain("github.com-dpi-agent");
    expect(result.ok).toBe(false); // 无效 key 的 clone 预期失败，但状态可诊断
    expect(result.error).toContain("clone");
  });
});
