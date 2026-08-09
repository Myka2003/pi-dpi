import { describe, expect, it } from "vitest";
import { fetchGatewayModels, inferReasoning } from "../src/gateway-catalog.ts";

describe("gateway catalog", () => {
  it("imports flat data[] as models without grouping", async () => {
    const models = await fetchGatewayModels("https://api.example.com/v1", "sk-x", {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.example.com/v1/models");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-5", display_name: "GPT-5" },
            { id: "claude-opus-4-8", display_name: "Opus" },
            { id: "deepseek-v4-flash" },
          ],
        }), { status: 200 });
      },
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-5", "claude-opus-4-8", "deepseek-v4-flash"]);
    expect(models[0].name).toBe("GPT-5");
    expect(models[0].input).toEqual(["text"]);
  });

  it("rejects non-ok responses", async () => {
    await expect(
      fetchGatewayModels("https://api.example.com/v1", "sk-x", {
        fetchImpl: async () => new Response("{}", { status: 401 }),
      }),
    ).rejects.toThrow(/401/);
  });
});

describe("pi official model catalog priority", () => {
  it("uses official catalog values when present, rules as fallback", async () => {
    const storePath = "/tmp/pi-models-store-test.json";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(storePath, JSON.stringify({
      deepseek: { models: [
        { id: "deepseek-v4-flash", api: "openai-completions", contextWindow: 1000000, maxTokens: 384000, reasoning: true },
      ] },
    }));
    const models = await fetchGatewayModels("https://api.example.com/v1", "sk-x", {
      catalogStorePath: storePath,
      fetchImpl: async (url, init) => {
        return new Response(JSON.stringify({ data: [
          { id: "deepseek-v4-flash" },
          { id: "gpt-5.6-luna" },
          { id: "claude-sonnet-4-5" },
        ] }), { status: 200 });
      },
    } as never);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["deepseek-v4-flash"].contextWindow).toBe(1000000);
    expect(byId["deepseek-v4-flash"].maxTokens).toBe(384000);
    expect(byId["deepseek-v4-flash"].reasoning).toBe(true);
    expect(byId["deepseek-v4-flash"].api).toBe("openai-completions");
    // 缓存未命中 → 规则兜底
    expect(byId["gpt-5.6-luna"].contextWindow).toBe(400000);
    expect(byId["gpt-5.6-luna"].api).toBe("openai-responses");
    expect(byId["claude-sonnet-4-5"].contextWindow).toBe(200000);
    expect(byId["claude-sonnet-4-5"].api).toBeUndefined();
  });
});

describe("inferReasoning", () => {
  it.each([
    ["gpt-5.6-luna", true],
    ["claude-sonnet-4-5", true],
    ["deepseek-v4-pro", true],
    ["o4-mini", true],
    ["babbage-002", false],
    ["dall-e-3", false],
    ["apimart/gpt-5.6-terra", true],
  ])("%s -> %s", (id, expected) => {
    expect(inferReasoning(id)).toBe(expected);
  });
});

describe("official catalog reasoning priority", () => {
  it("official reasoning wins over inference", async () => {
    const storePath = "/tmp/pi-models-store-test2.json";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(storePath, JSON.stringify({
      deepseek: { models: [{ id: "deepseek-v4-flash", reasoning: false }] },
    }));
    const models = await fetchGatewayModels("https://api.example.com/v1", "sk-x", {
      catalogStorePath: storePath,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 }),
    } as never);
    expect(models[0].reasoning).toBe(false); // 官方显式 false 覆盖家族规则 true
  });
});

describe("official thinkingLevelMap and compat passthrough", () => {
  it("carries thinkingLevelMap and compat from the pi catalog", async () => {
    const storePath = "/tmp/pi-models-store-test3.json";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(storePath, JSON.stringify({
      deepseek: { models: [{
        id: "deepseek-v4-flash",
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
        compat: { supportsStore: false, thinkingFormat: "deepseek" },
      }] },
    }));
    const models = await fetchGatewayModels("https://api.example.com/v1", "sk-x", {
      catalogStorePath: storePath,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 }),
    } as never);
    expect(models[0].thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", max: "max" });
    expect(models[0].compat).toEqual({ supportsStore: false, thinkingFormat: "deepseek" });
  });
});
