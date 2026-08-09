import { describe, expect, it } from "vitest";
import { projectGatewayModels, clearProjectedGateway, managedProviderId } from "../src/gateway-projection.ts";
import type { GatewayProfile } from "../src/gateway-profile.ts";

const profile: GatewayProfile = {
  schema: 1,
  id: "ser7-cpa",
  label: "ser7 CPA",
  baseUrl: "http://100.102.192.34:8317/v1",
  credentialRef: "riff-cpa-client-token",
  providers: [
    {
      id: "deepseek-cpa",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 1000000,
          maxTokens: 384000,
          compat: { supportsDeveloperRole: false },
        },
      ],
    },
  ],
};

describe("gateway provider projection", () => {
  it("adds a command-backed provider while preserving unrelated providers", () => {
    const existing = {
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [] },
        [managedProviderId("old-gateway", "old-provider")]: { apiKey: "!old-command" },
      },
    };
    const next = projectGatewayModels(existing, profile, { kind: "command", value: "cat /run/agenix/riff-cpa-client-token" }) as typeof existing;
    expect(next.providers.ollama).toEqual(existing.providers.ollama);
    expect(next.providers[managedProviderId("ser7-cpa", "deepseek-cpa")]).toEqual({
      baseUrl: profile.baseUrl,
      api: "openai-completions",
      apiKey: "!cat /run/agenix/riff-cpa-client-token",
      models: [profile.providers[0].models[0]],
    });
    expect(JSON.stringify(next)).not.toContain("sk-test-secret");
  });

  it("projects a schema 2 provider with its own baseUrl and direct apiKey literal", () => {
    const schema2: GatewayProfile = {
      schema: 2,
      id: "ser7-cpa",
      label: "ser7 CPA",
      baseUrl: "http://100.102.192.34:8317/v1",
      apiKey: "sk-entry-secret",
      providers: [
        {
          id: "deepseek-cpa",
          api: "openai-completions",
          baseUrl: "https://upstream.example.com/v1",
          apiKey: "sk-provider-secret",
          models: [{ id: "m1" }],
        },
      ],
    };
    const next = projectGatewayModels({}, schema2, {
      kind: "direct",
      value: "sk-provider-secret",
    }) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
    expect(next.providers[managedProviderId("ser7-cpa", "deepseek-cpa")]).toEqual({
      baseUrl: "https://upstream.example.com/v1", // provider 级上游地址直用
      api: "openai-completions",
      apiKey: "sk-provider-secret", // schema 2 直接 key 字面量直用
      models: [{ id: "m1" }],
    });
  });

  it("schema 2 provider without its own baseUrl falls back to the profile baseUrl", () => {
    const schema2: GatewayProfile = {
      schema: 2,
      id: "ser7-cpa",
      baseUrl: "http://100.102.192.34:8317/v1",
      apiKey: "sk-entry-secret",
      providers: [{ id: "p1", api: "openai-completions", models: [{ id: "m1" }] }],
    };
    const next = projectGatewayModels({}, schema2, {
      kind: "direct",
      value: "sk-entry-secret",
    }) as { providers: Record<string, { baseUrl: string }> };
    expect(next.providers[managedProviderId("ser7-cpa", "p1")].baseUrl).toBe(
      "http://100.102.192.34:8317/v1",
    );
  });

  it("schema 1 provider baseUrl is ignored (projection stays on profile baseUrl)", () => {
    const legacy: GatewayProfile = {
      ...profile,
      providers: [
        {
          ...profile.providers[0],
          baseUrl: "https://ignored.example.com/v1",
        },
      ],
    };
    const next = projectGatewayModels({}, legacy, {
      kind: "command",
      value: "cat /run/agenix/riff-cpa-client-token",
    }) as { providers: Record<string, { baseUrl: string }> };
    expect(next.providers[managedProviderId("ser7-cpa", "deepseek-cpa")].baseUrl).toBe(
      profile.baseUrl,
    );
  });

  it("clears only dpi-managed providers", () => {
    const existing = {
      providers: {
        ollama: { apiKey: "ollama" },
        [managedProviderId("ser7-cpa", "deepseek-cpa")]: { apiKey: "!cat token" },
        [managedProviderId("other", "kimi")]: { apiKey: "!cat other" },
      },
    };
    expect(clearProjectedGateway(existing)).toEqual({ providers: { ollama: { apiKey: "ollama" } } });
  });
});
