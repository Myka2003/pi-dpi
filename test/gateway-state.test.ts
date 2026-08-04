import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { clearGatewayState, loadGatewayState, saveGatewayState } from "../src/gateway-state.ts";

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("dpi gateway state", () => {
  it("keeps old configs backward compatible with no selected gateway", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-gateway-state-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    expect(defaultConfig().currentGateway).toBe("");
    expect(loadConfig().currentGateway).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and clears the selected gateway in the existing secure config", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-gateway-state-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    saveConfig({ repoUrl: "/tmp/agent-repo", currentGateway: "ser7-cpa" });
    expect(loadGatewayState()).toBe("ser7-cpa");
    expect(clearGatewayState()).toBe(true);
    expect(loadGatewayState()).toBe("");
    const configPath = join(dir, "dpi", "config.json");
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).currentGateway).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
