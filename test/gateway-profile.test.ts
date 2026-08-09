import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directGatewayKey,
  parseGatewayProfile,
  resolveCredentialRef,
  resolveGatewaySecret,
  scanGatewayProfiles,
  type GatewayProfile,
  type GatewayProvider,
} from "../src/gateway-profile.ts";

const validProfile = {
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
        },
      ],
    },
  ],
};

describe("gateway profiles — schema 2 (keys in repo)", () => {
  const schema2Profile: GatewayProfile = {
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
        models: [{ id: "deepseek-v4-flash", reasoning: true }],
      },
      {
        id: "fallback",
        api: "openai-completions",
        models: [{ id: "m1" }],
      },
    ],
  };

  it("parses a schema 2 profile with direct keys (profile + provider level)", () => {
    expect(parseGatewayProfile(schema2Profile)).toEqual(schema2Profile);
  });

  it("serializes and re-parses via write/scan round-trip", () => {
    const repo = mkdtempSync(join(tmpdir(), "dpi-gateway-schema2-"));
    const profiles = join(repo, "profiles", "gateways");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "ser7-cpa.json"), JSON.stringify(schema2Profile));
    expect(scanGatewayProfiles(repo)).toEqual([schema2Profile]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("still parses schema 1 legacy files (compat)", () => {
    expect(parseGatewayProfile(validProfile)).toEqual(validProfile);
  });

  it("sensitive-key rejection still applies to schema 1, not schema 2", () => {
    // schema 1：profile 级或 provider 级 apiKey 都被拒绝
    expect(parseGatewayProfile({ ...validProfile, apiKey: "sk-test-secret" })).toBeNull();
    expect(
      parseGatewayProfile({
        ...validProfile,
        providers: [{ ...validProfile.providers[0], apiKey: "sk-x" }],
      }),
    ).toBeNull();
    // schema 2：同一字段合法
    expect(parseGatewayProfile(schema2Profile)).not.toBeNull();
  });

  it("rejects malformed schema 2 keys and endpoints", () => {
    expect(parseGatewayProfile({ ...schema2Profile, apiKey: "" })).toBeNull();
    expect(parseGatewayProfile({ ...schema2Profile, apiKey: "   " })).toBeNull();
    expect(
      parseGatewayProfile({
        ...schema2Profile,
        providers: [{ ...schema2Profile.providers[0], baseUrl: "http://localhost:1/v1" }],
      }),
    ).toBeNull();
    expect(
      parseGatewayProfile({
        ...schema2Profile,
        providers: [{ ...schema2Profile.providers[0], apiKey: "" }],
      }),
    ).toBeNull();
    expect(parseGatewayProfile({ ...schema2Profile, schema: 3 })).toBeNull();
  });

  it("resolves direct keys before the credentialRef path (consumer priority)", () => {
    // schema 2：provider.apiKey 优先，其次 profile.apiKey
    expect(
      resolveGatewaySecret(schema2Profile, schema2Profile.providers[0]),
    ).toEqual({ kind: "direct", value: "sk-provider-secret" });
    expect(
      resolveGatewaySecret(schema2Profile, schema2Profile.providers[1]),
    ).toEqual({ kind: "direct", value: "sk-entry-secret" });
    expect(directGatewayKey(schema2Profile, schema2Profile.providers[1])).toBe("sk-entry-secret");
    // schema 1：无直接 key → credentialRef 命令路径
    const legacy = validProfile as GatewayProfile;
    expect(
      resolveGatewaySecret(legacy, legacy.providers[0] as GatewayProvider, {
        DPI_CREDENTIAL_REF_RIFF_CPA_CLIENT_TOKEN: "!cat /run/agenix/riff-cpa-client-token",
      }),
    ).toEqual({ kind: "command", value: "cat /run/agenix/riff-cpa-client-token" });
  });
});

describe("gateway profiles", () => {
  it("parses a valid remote CPA profile with public model metadata", () => {
    expect(parseGatewayProfile(validProfile)).toEqual(validProfile);
  });

  it("rejects token-like fields and malformed endpoints", () => {
    expect(parseGatewayProfile({ ...validProfile, apiKey: "sk-test-secret" })).toBeNull();
    expect(parseGatewayProfile({ ...validProfile, baseUrl: "http://localhost:8317/v1" })).toBeNull();
    expect(parseGatewayProfile({ ...validProfile, baseUrl: "https://ser7.example.invalid" })).toBeNull();
  });

  it("scans only safe JSON files inside profiles/gateways", () => {
    const repo = mkdtempSync(join(tmpdir(), "dpi-gateway-profile-"));
    const profiles = join(repo, "profiles", "gateways");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "ser7-cpa.json"), JSON.stringify(validProfile));
    writeFileSync(join(profiles, "broken.json"), "not-json");
    const outside = join(repo, "outside.json");
    writeFileSync(outside, JSON.stringify({ ...validProfile, id: "outside" }));
    symlinkSync(outside, join(profiles, "escape.json"));

    expect(scanGatewayProfiles(repo)).toEqual([validProfile]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("resolves a logical reference from a platform-provided command mapping", () => {
    expect(
      resolveCredentialRef("riff-cpa-client-token", {
        DPI_CREDENTIAL_REF_RIFF_CPA_CLIENT_TOKEN: "!cat /run/agenix/riff-cpa-client-token",
      }),
    ).toEqual({ kind: "command", value: "cat /run/agenix/riff-cpa-client-token" });
  });

  it("does not expose missing credential values", () => {
    expect(resolveCredentialRef("riff-cpa-client-token", {}, "/nonexistent/dpi-credentials")).toEqual({
      kind: "missing",
      reason: "credential reference unavailable: riff-cpa-client-token",
    });
  });

  it("falls back to a user credential command file when no env mapping exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-creds-"));
    writeFileSync(join(dir, "riff-cpa-client-token"), "!security find-generic-password -s riff-cpa-client-token -w");
    expect(resolveCredentialRef("riff-cpa-client-token", {}, dir)).toEqual({
      kind: "command",
      value: "security find-generic-password -s riff-cpa-client-token -w",
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
