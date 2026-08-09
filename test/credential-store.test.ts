import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteCredential, readCredential, validateRef, writeCredential } from "../src/credential-store.ts";

let root = "";
function useTempHome(): void {
  root = mkdtempSync(join(tmpdir(), "dpi-cred-"));
  delete process.env.HOME;
  process.env.HOME = root;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("credential store", () => {
  it("rejects invalid refs", () => {
    expect(validateRef("ok-id")).toBe(true);
    expect(validateRef("Bad ID")).toBe(false);
    expect(validateRef("a/b")).toBe(false);
  });

  it("writes 0600 file containing a !printf command, readable back as raw key", () => {
    useTempHome();
    expect(writeCredential("apimart", "sk-secret123")).toBe(true);
    const file = join(root, ".config", "dpi", "credentials", "apimart");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(file, "utf-8")).toBe("!printf %s 'sk-secret123'\n");
    expect(readCredential("apimart")).toBe("sk-secret123");
  });

  it("round-trips keys with single quotes", () => {
    useTempHome();
    expect(writeCredential("quoted", "a'b")).toBe(true);
    expect(readCredential("quoted")).toBe("a'b");
  });

  it("delete removes the file", () => {
    useTempHome();
    writeCredential("gone", "x");
    deleteCredential("gone");
    expect(readCredential("gone")).toBeNull();
  });
});
