import type { GatewayModel } from "./gateway-profile.ts";

export async function fetchGatewayModels(
  baseUrl: string,
  key: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
  });
  if (!response.ok) throw new Error(`/models returned HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: unknown[] };
  if (!Array.isArray(payload.data)) throw new Error("/models returned no data array");
  return payload.data
    .filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null)
    .map((raw) => ({
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : undefined,
      input: ["text"] as GatewayModel["input"],
    }))
    .filter((m) => m.id !== "");
}
