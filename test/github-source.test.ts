import { describe, expect, it } from "vitest";
import { parseInstallSource, githubOwnerRepo } from "../src/github-source.ts";

describe("githubOwnerRepo", () => {
  it("解析仓库根 URL", () => {
    expect(githubOwnerRepo("https://github.com/aas-ee/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
  });
  it("解析 tree/blob 路径 URL（忽略后缀）", () => {
    expect(githubOwnerRepo("https://github.com/aas-ee/open-websearch/tree/main/skills/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
    expect(githubOwnerRepo("https://github.com/owner/repo/blob/main/README.md"))
      .toEqual({ owner: "owner", repo: "repo" });
  });
  it("解析 owner/repo 简写", () => {
    expect(githubOwnerRepo("aas-ee/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
  });
  it("非 GitHub 返回 null", () => {
    expect(githubOwnerRepo("https://gitlab.com/x/y")).toBeNull();
    expect(githubOwnerRepo("https://example.com")).toBeNull();
  });
});

describe("parseInstallSource", () => {
  it("GitHub URL → github 类型", () => {
    expect(parseInstallSource("https://github.com/aas-ee/open-websearch"))
      .toEqual({ kind: "github", owner: "aas-ee", repo: "open-websearch" });
  });
  it("owner/repo → github 类型", () => {
    expect(parseInstallSource("aas-ee/open-websearch"))
      .toEqual({ kind: "github", owner: "aas-ee", repo: "open-websearch" });
  });
  it("npm 包名（含 npm: 前缀与裸名）→ npm 类型", () => {
    expect(parseInstallSource("npm:pi-mcp-adapter"))
      .toEqual({ kind: "npm", name: "pi-mcp-adapter" });
    expect(parseInstallSource("pi-mcp-adapter"))
      .toEqual({ kind: "npm", name: "pi-mcp-adapter" });
  });
  it("空输入 → null", () => {
    expect(parseInstallSource("")).toBeNull();
    expect(parseInstallSource("   ")).toBeNull();
  });
});
