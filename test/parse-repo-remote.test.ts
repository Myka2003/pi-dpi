import { describe, expect, it } from "vitest";
import { parseRepoRemote } from "../src/../extensions/dpi-auth.ts";
import { inferRemoteKind } from "../src/config.ts";

describe("parseRepoRemote 远端类型矩阵（README 承诺的行为）", () => {
  it("GitHub 短格式 user/repo 归一化为 https URL", () => {
    expect(parseRepoRemote("user/repo")).toEqual({
      kind: "github",
      url: "https://github.com/user/repo.git",
    });
  });

  it("github.com/user/repo 与 https 写法归一化", () => {
    expect(parseRepoRemote("github.com/user/repo")).toEqual({
      kind: "github",
      url: "https://github.com/user/repo.git",
    });
    expect(parseRepoRemote("https://github.com/user/repo.git")).toEqual({
      kind: "github",
      url: "https://github.com/user/repo.git",
    });
    expect(parseRepoRemote("https://github.com/user/repo/")).toEqual({
      kind: "github",
      url: "https://github.com/user/repo.git",
    });
  });

  it("git@github.com:… 走 SSH 类型（scp-like 分支先行，README 矩阵声明）", () => {
    expect(parseRepoRemote("git@github.com:user/repo.git")).toEqual({
      kind: "ssh",
      url: "git@github.com:user/repo.git",
    });
  });

  it("通用 scp-like 与 ssh:// 走 SSH，地址原样", () => {
    expect(parseRepoRemote("git@gitlab.example.com:team/repo.git")).toEqual({
      kind: "ssh",
      url: "git@gitlab.example.com:team/repo.git",
    });
    expect(parseRepoRemote("ssh://git@example.com/team/repo")).toEqual({
      kind: "ssh",
      url: "ssh://git@example.com/team/repo",
    });
  });

  it("非 GitHub 的 https 托管走通用 http，地址原样", () => {
    expect(parseRepoRemote("https://gitea.example.com/user/repo.git")).toEqual({
      kind: "http",
      url: "https://gitea.example.com/user/repo.git",
    });
  });

  it("本地路径：绝对路径 / ~ 展开 / file://", () => {
    expect(parseRepoRemote("/srv/agents")).toEqual({
      kind: "local",
      url: "/srv/agents",
    });
    expect(parseRepoRemote("~/srv/agents.git")).toEqual({
      kind: "local",
      url: expect.stringContaining("/srv/agents.git"), // homedir 前缀
    });
    expect(parseRepoRemote("file:///srv/agents")).toEqual({
      kind: "local",
      url: "/srv/agents",
    });
  });

  it("空输入与无法识别的地址返回 null", () => {
    expect(parseRepoRemote("")).toBeNull();
    expect(parseRepoRemote("   ")).toBeNull();
    expect(parseRepoRemote("git@")).toBeNull();
    expect(parseRepoRemote("just-a-word")).toBeNull();
  });
});

describe("inferRemoteKind 旧配置迁移", () => {
  it("按 repoUrl 推断远端类型", () => {
    expect(inferRemoteKind("https://github.com/a/b")).toBe("github");
    expect(inferRemoteKind("git@github.com:a/b")).toBe("ssh");
    expect(inferRemoteKind("ssh://git@h/a")).toBe("ssh");
    expect(inferRemoteKind("https://gitea.com/a/b")).toBe("http");
    expect(inferRemoteKind("/tmp/repo")).toBe("local");
    expect(inferRemoteKind("~/repo")).toBe("local");
    expect(inferRemoteKind("")).toBe("github"); // 空串回退默认
    expect(inferRemoteKind("无法识别")).toBe("github");
  });
});
