import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeclarationWatch } from "../src/declaration-watch.ts";

describe("DeclarationWatch agent.json 变更检测", () => {
  it("首次调用只记录基线不报变化", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const agents = join(dir, "agents", "coder");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "agent.json"), "{\"skills\":[]}\n");
    const w = new DeclarationWatch();
    expect(w.changed(dir, "coder")).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("内容变化后检测到变更", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const agents = join(dir, "agents", "coder");
    mkdirSync(agents, { recursive: true });
    const f = join(agents, "agent.json");
    writeFileSync(f, "{\"skills\":[]}\n");
    const w = new DeclarationWatch();
    w.changed(dir, "coder");
    writeFileSync(f, "{\"skills\":[\"commit\"]}\n");
    expect(w.changed(dir, "coder")).toBe(true);
    expect(w.changed(dir, "coder")).toBe(false); // 基线更新后幂等
    rmSync(dir, { recursive: true });
  });

  it("文件被删除也视为变化", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const agents = join(dir, "agents", "coder");
    mkdirSync(agents, { recursive: true });
    const f = join(agents, "agent.json");
    writeFileSync(f, "{}");
    const w = new DeclarationWatch();
    w.changed(dir, "coder");
    rmSync(f);
    expect(w.changed(dir, "coder")).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
