import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("gateway health — schema 2 direct keys", () => {
  const schema2: GatewayProfile = {
    schema: 2,
    id: "ser7-cpa",
    baseUrl: "http://100.102.192.34:8317/v1",
    apiKey: "sk-in-repo",
    providers: [{ id: "deepseek-cpa", api: "openai-completions", models: [{ id: "m1" }] }],
  };

  it("checks /models with the in-repo profile apiKey (no credentialRef needed)", async () => {
    const report = await checkGatewayHealth(schema2, {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("http://100.102.192.34:8317/v1/models");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-in-repo");
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      },
    });
    expect(report.credential).toBe("resolved");
    expect(report.endpoint).toBe("reachable");
    expect(report.models).toBe(2);
    expect(report.ok).toBe(true);
  });

  it("prefers the explicit apiKey option over the profile key", async () => {
    const report = await checkGatewayHealth(schema2, {
      apiKey: "sk-explicit",
      fetchImpl: async (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-explicit");
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
      },
    });
    expect(report.ok).toBe(true);
  });

  it("schema 2 without any key reports missing without throwing (credentialRef absent)", async () => {
    const keyless: GatewayProfile = {
      schema: 2,
      id: "ser7-cpa",
      baseUrl: "http://100.102.192.34:8317/v1",
      providers: [{ id: "deepseek-cpa", api: "openai-completions", models: [{ id: "m1" }] }],
    };
    const report = await checkGatewayHealth(keyless, {
      fetchImpl: async () => new Response("{}"),
    });
    expect(report.credential).toBe("missing");
    expect(report.ok).toBe(false);
    expect(report.issues.join(" ")).toContain("no apiKey or credentialRef");
  });
});

describe("gateway health", () => {
  it("reports missing credential without printing command output", async () => {
    const credentialDir = mkdtempSync(join(tmpdir(), "dpi-gw-health-"));
    try {
      delete process.env.DPI_CREDENTIAL_REF_RIFF_CPA_CLIENT_TOKEN;
      const report = await checkGatewayHealth(profile, {
        fetchImpl: async () => new Response("{}"),
        credentialDir,
      });
      expect(report.credential).toBe("missing");
      expect(report.ok).toBe(false);
      expect(JSON.stringify(report)).not.toContain("secret");
    } finally {
      rmSync(credentialDir, { recursive: true, force: true });
    }
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
