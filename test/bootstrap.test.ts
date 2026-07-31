import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureContentRepo } from "../src/bootstrap.ts";

describe("ensureContentRepo bootstrap", () => {
  it("creates minimal structure in an empty dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const result = ensureContentRepo(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, "agents/coder/SYSTEM.md"))).toBe(true);
    expect(existsSync(join(dir, "agents/coder/agent.json"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "extensions"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("is idempotent (no overwrite when structure exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    ensureContentRepo(dir);
    const custom = "# my custom persona\n";
    writeFileSync(join(dir, "agents/coder/SYSTEM.md"), custom);
    const result = ensureContentRepo(dir);
    expect(result.created).toBe(false);
    expect(readFileSync(join(dir, "agents/coder/SYSTEM.md"), "utf-8")).toBe(custom);
    rmSync(dir, { recursive: true });
  });
});
