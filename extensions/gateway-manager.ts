import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import {
  resolveCredentialRef,
  scanGatewayProfiles,
  type GatewayProfile,
} from "../src/gateway-profile.ts";
import { gatewayProviderId, toPiProviderConfig } from "../src/gateway-projection.ts";
import { clearGatewayState, loadGatewayState, saveGatewayState } from "../src/gateway-state.ts";
import { registerDpiCommand } from "../src/command-alias.ts";
import { checkGatewayHealth } from "../src/gateway-health.ts";

let activeProviderIds: string[] = [];

function profiles(): GatewayProfile[] {
  const cfg = loadConfig();
  return cfg.repoUrl ? scanGatewayProfiles(cfg.repoPath) : [];
}

function findProfile(id: string): GatewayProfile | undefined {
  return profiles().find((profile) => profile.id === id);
}

function unregisterActive(pi: ExtensionAPI): void {
  for (const id of activeProviderIds) pi.unregisterProvider(id);
  activeProviderIds = [];
}

function applyProfile(pi: ExtensionAPI, profile: GatewayProfile): { ok: true } | { ok: false; reason: string } {
  const credential = resolveCredentialRef(profile.credentialRef);
  if (credential.kind === "missing") return { ok: false, reason: credential.reason };

  unregisterActive(pi);
  for (const provider of profile.providers) {
    const id = gatewayProviderId(profile.id, provider.id);
    const config = toPiProviderConfig(profile, provider, credential) as unknown as ProviderConfig;
    pi.registerProvider(id, config);
    activeProviderIds.push(id);
  }
  saveGatewayState(profile.id);
  return { ok: true };
}

function formatHealth(profile: GatewayProfile, report: Awaited<ReturnType<typeof checkGatewayHealth>>): string {
  return [
    `selected: ${profile.id}`,
    `baseUrl: ${profile.baseUrl}`,
    `credentialRef: ${profile.credentialRef}`,
    `credential: ${report.credential}`,
    `providers: ${report.providers}`,
    `models: ${report.models}`,
    `/models: ${report.endpoint}${report.latencyMs !== undefined ? ` (${report.latencyMs} ms)` : ""}`,
    ...(report.issues.length ? ["issues:", ...report.issues.map((issue) => `- ${issue}`)] : []),
  ].join("\n");
}

function formatProfiles(items: GatewayProfile[], current: string): string {
  if (items.length === 0) return "No gateway profiles found in the bound Agent repository";
  return items
    .map((profile) => `${profile.id === current ? "*" : " "} ${profile.id}${profile.label ? ` — ${profile.label}` : ""} (${profile.baseUrl})`)
    .join("\n");
}

export async function useGateway(pi: ExtensionAPI, id: string, ctx: ExtensionCommandContext): Promise<void> {
  const profile = findProfile(id);
  if (!profile) {
    ctx.ui.notify(`Unknown gateway: ${id || "(empty)"}`, "error");
    return;
  }
  const health = await checkGatewayHealth(profile);
  if (!health.ok) {
    ctx.ui.notify(formatHealth(profile, health), "error");
    return;
  }
  const result = applyProfile(pi, profile);
  if (!result.ok) {
    ctx.ui.notify(result.reason, "error");
    return;
  }
  ctx.ui.notify(`Gateway selected: ${profile.id}\nProviders registered: ${profile.providers.map((item) => gatewayProviderId(profile.id, item.id)).join(", ")}`, "info");
}

export default function (pi: ExtensionAPI): void {
  const current = loadGatewayState();
  if (current) {
    const profile = findProfile(current);
    if (profile) {
      const result = applyProfile(pi, profile);
      if (!result.ok) {
        // The command path reports the reference name; startup remains non-fatal.
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    unregisterActive(pi);
    const current = loadGatewayState();
    if (!current) return;
    const profile = findProfile(current);
    if (!profile) {
      ctx.ui.notify(`Selected gateway is unavailable: ${current}`, "warning");
      clearGatewayState();
      return;
    }
    const result = applyProfile(pi, profile);
    if (!result.ok) ctx.ui.notify(result.reason, "warning");
  });

  pi.on("session_shutdown", () => {
    unregisterActive(pi);
  });

  registerDpiCommand(pi, "dpi-gateway", {
    description: "List, select, inspect, or clear Agent gateway profiles",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [subcommand, value] = input.split(/\s+/, 2);
      const current = loadGatewayState();
      if (!subcommand || subcommand === "list") {
        ctx.ui.notify(formatProfiles(profiles(), current), "info");
        return;
      }
      if (subcommand === "status") {
        const profile = current ? findProfile(current) : undefined;
        if (!profile) {
          ctx.ui.notify("No gateway selected", "info");
          return;
        }
        const report = await checkGatewayHealth(profile);
        ctx.ui.notify(formatHealth(profile, report), report.ok ? "info" : "warning");
        return;
      }
      if (subcommand === "doctor") {
        const items = profiles();
        if (items.length === 0) {
          ctx.ui.notify("No gateway profiles found in the bound Agent repository", "info");
          return;
        }
        let allOk = true;
        const blocks: string[] = [];
        for (const profile of items) {
          const report = await checkGatewayHealth(profile);
          if (!report.ok) allOk = false;
          const selected = profile.id === current ? " (selected)" : "";
          blocks.push(`Gateway: ${profile.id}${selected}\n${formatHealth(profile, report).split("\n").slice(1).join("\n")}`);
        }
        ctx.ui.notify(blocks.join("\n\n"), allOk ? "info" : "warning");
        return;
      }
      if (subcommand === "clear") {
        unregisterActive(pi);
        clearGatewayState();
        ctx.ui.notify("Gateway cleared; dpi providers unregistered", "info");
        return;
      }
      if (subcommand === "use") {
        if (!value) {
          ctx.ui.notify("Usage: /dpi-gateway use <gateway-id>", "error");
          return;
        }
        await useGateway(pi, value, ctx);
        return;
      }
      ctx.ui.notify("Usage: /dpi-gateway {list|use <id>|status|doctor|clear}", "error");
    },
  });
}
