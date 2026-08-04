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
