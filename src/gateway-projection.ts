import type { GatewayProfile, GatewayModel, GatewayProvider } from "./gateway-profile.ts";

export const MANAGED_PROVIDER_PREFIX = "dpi-gateway-";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function managedProviderId(gatewayId: string, providerId: string): string {
  return `${MANAGED_PROVIDER_PREFIX}${gatewayId}-${providerId}`;
}

function providerProjection(profile: GatewayProfile, provider: GatewayProvider, apiKey: string): JsonRecord {
  const value: JsonRecord = {
    baseUrl: profile.baseUrl,
    api: provider.api,
    apiKey: `!${apiKey}`,
    models: provider.models,
  };
  if (provider.name !== undefined) value.name = provider.name;
  if (provider.compat !== undefined) value.compat = provider.compat;
  return value;
}

export function projectGatewayModels(
  existing: unknown,
  profile: GatewayProfile,
  credential: { kind: "command"; value: string },
): JsonRecord {
  const root: JsonRecord = isRecord(existing) ? { ...existing } : {};
  const existingProviders = isRecord(root.providers) ? root.providers : {};
  const providers: JsonRecord = {};
  for (const [id, value] of Object.entries(existingProviders)) {
    if (!id.startsWith(MANAGED_PROVIDER_PREFIX)) providers[id] = value;
  }
  for (const provider of profile.providers) {
    providers[managedProviderId(profile.id, provider.id)] = providerProjection(profile, provider, credential.value);
  }
  root.providers = providers;
  return root;
}

export function gatewayProviderId(gatewayId: string, providerId: string): string {
  return managedProviderId(gatewayId, providerId);
}

function piModel(model: GatewayModel): JsonRecord {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 16384,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}

export function toPiProviderConfig(
  profile: GatewayProfile,
  provider: GatewayProvider,
  credential: { kind: "command"; value: string },
): JsonRecord {
  return {
    name: provider.name ?? `${profile.label ?? profile.id} ${provider.id}`,
    baseUrl: profile.baseUrl,
    api: provider.api,
    apiKey: `!${credential.value}`,
    models: provider.models.map(piModel),
    ...(provider.compat ? { compat: provider.compat } : {}),
  };
}

export function clearProjectedGateway(existing: unknown): JsonRecord {
  const root: JsonRecord = isRecord(existing) ? { ...existing } : {};
  const existingProviders = isRecord(root.providers) ? root.providers : {};
  root.providers = Object.fromEntries(
    Object.entries(existingProviders).filter(([id]) => !id.startsWith(MANAGED_PROVIDER_PREFIX)),
  );
  return root;
}
