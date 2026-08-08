import { describe, expect, it } from "vitest";
import { checkGatewayHealth } from "../src/gateway-health.ts";
import type { GatewayProfile } from "../src/gateway-profile.ts";

const profile: GatewayProfile = {
  schema: 1,
  id: "ser7-cpa",
  baseUrl: "http://100.102.192.34:8317/v1",
  credentialRef: "riff-cpa-client-token",
  providers: [{ id: "deepseek-cpa", api: "openai-completions", models: [{ id: "deepseek-v4-flash" }] }],
};

describe("gateway health", () => {
  it("reports missing credential without printing command output", async () => {
    delete process.env.DPI_CREDENTIAL_REF_RIFF_CPA_CLIENT_TOKEN;
    const report = await checkGatewayHealth(profile, { fetchImpl: async () => new Response("{}") });
    expect(report.credential).toBe("missing");
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("checks /models with command-backed credential", async () => {
    process.env.DPI_CREDENTIAL_REF_RIFF_CPA_CLIENT_TOKEN = "!printf test-token";
    const report = await checkGatewayHealth(profile, {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("http://100.102.192.34:8317/v1/models");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      },
    });
    expect(report.credential).toBe("resolved");
    expect(report.endpoint).toBe("reachable");
    expect(report.models).toBe(2);
    expect(report.ok).toBe(true);
  });
});
