import type {
  GatewayProfile,
  GatewayModel,
  GatewayProvider,
  GatewaySecret,
} from "./gateway-profile.ts";

export const MANAGED_PROVIDER_PREFIX = "dpi-gateway-";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function managedProviderId(gatewayId: string, providerId: string): string {
  return `${MANAGED_PROVIDER_PREFIX}${gatewayId}-${providerId}`;
}

/** provider 级上游地址：仅 schema 2 允许 provider.baseUrl 覆盖；schema 1 保持
 * 投影到 profile.baseUrl（旧路径，provider.baseUrl 字段被忽略）。 */
function providerBaseUrl(profile: GatewayProfile, provider: GatewayProvider): string {
  return profile.schema === 2 && provider.baseUrl !== undefined ? provider.baseUrl : profile.baseUrl;
}

/** 投影为 pi provider 的 apiKey：schema 1 的命令（credentialRef）以 `!command`
 * 形式由 pi 运行时取明文；schema 2 的直接 key 按字面量直用。 */
function secretApiKey(secret: GatewaySecret): string {
  return secret.kind === "command" ? `!${secret.value}` : secret.value;
}

function providerProjection(profile: GatewayProfile, provider: GatewayProvider, secret: GatewaySecret): JsonRecord {
  const value: JsonRecord = {
    baseUrl: providerBaseUrl(profile, provider),
    api: provider.api,
    apiKey: secretApiKey(secret),
    models: provider.models,
  };
  if (provider.name !== undefined) value.name = provider.name;
  if (provider.compat !== undefined) value.compat = provider.compat;
  return value;
}

export function projectGatewayModels(
  existing: unknown,
  profile: GatewayProfile,
  secret: GatewaySecret,
): JsonRecord {
  const root: JsonRecord = isRecord(existing) ? { ...existing } : {};
  const existingProviders = isRecord(root.providers) ? root.providers : {};
  const providers: JsonRecord = {};
  for (const [id, value] of Object.entries(existingProviders)) {
    if (!id.startsWith(MANAGED_PROVIDER_PREFIX)) providers[id] = value;
  }
  for (const provider of profile.providers) {
    providers[managedProviderId(profile.id, provider.id)] = providerProjection(profile, provider, secret);
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
  secret: GatewaySecret,
): JsonRecord {
  return {
    name: provider.name ?? `${profile.label ?? profile.id} ${provider.id}`,
    baseUrl: providerBaseUrl(profile, provider),
    api: provider.api,
    apiKey: secretApiKey(secret),
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
