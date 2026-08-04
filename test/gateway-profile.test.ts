import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGatewayProfile,
  resolveCredentialRef,
  scanGatewayProfiles,
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
    expect(resolveCredentialRef("riff-cpa-client-token", {})).toEqual({
      kind: "missing",
      reason: "credential reference unavailable: riff-cpa-client-token",
    });
  });
});
