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

function formatProfiles(items: GatewayProfile[], current: string): string {
  if (items.length === 0) return "No gateway profiles found in the bound Agent repository";
  return items
    .map((profile) => `${profile.id === current ? "*" : " "} ${profile.id}${profile.label ? ` — ${profile.label}` : ""} (${profile.baseUrl})`)
    .join("\n");
}

async function useGateway(pi: ExtensionAPI, id: string, ctx: ExtensionCommandContext): Promise<void> {
  const profile = findProfile(id);
  if (!profile) {
    ctx.ui.notify(`Unknown gateway: ${id || "(empty)"}`, "error");
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
        ctx.ui.notify(profile ? `Gateway: ${profile.id}\nEndpoint: ${profile.baseUrl}` : "No gateway selected", "info");
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
      ctx.ui.notify("Usage: /dpi-gateway {list|use <id>|status|clear}", "error");
    },
  });
}
