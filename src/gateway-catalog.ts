import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./config.ts";
import type { GatewayModel } from "./gateway-profile.ts";

/**
 * 模型上下文窗口推断规则（前缀匹配，不区分大小写）。匹配时先取 id 中
 * 最后一个 "/" 之后的部分（兼容 vendor 前缀 id 如 "apimart/claude-sonnet-4-5"），
 * 再按前缀命中；多个规则同时命中时取最长前缀。
 *
 * 数值来源备注：
 * - claude-* 200000：Anthropic Claude 全系（sonnet/opus 等）官方 200K。
 * - gemini-* 1048576：Gemini 各代官方 1M（1048576）。
 * - gpt-3.5* 16384：gpt-3.5-turbo-16k 的上下文长度。
 * - gpt-4-turbo / gpt-4o 系 128000：OpenAI 官方 128K。
 * - gpt-4.1* 1048576：gpt-4.1 系列官方 1M。
 * - o1-、o3-、o4- 系 200000：o 系列官方 200K。
 * - gpt-5* 400000：gpt-5 官方 400K；部分变体（如 nano）实际更低，此处取 400000 存在不确定性。
 * - deepseek-v4* 1048576：deepseek-v4 系官方 1M（见 DeepSeek API 文档与 pi 官方模型目录）。
 * - deepseek-* 65536：deepseek-v3 / r1 / chat / reasoner 官方 64K。
 * - moonshot-、kimi- 系 128000：kimi 系列官方 128K。
 * - qwen-* 131072：qwen-plus 的上下文长度（131072）。
 * - glm-* 128000：GLM-4 系列官方 128K。
 * - mistral-、llama-、grok-、command- 系 131072：各系旗舰（mistral-large、
 *   llama 3.x、grok、command-r 等）约 128K（131072）。
 * - 其余未知模型默认 128000。
 */
const CONTEXT_RULES: ReadonlyArray<readonly [prefix: string, contextWindow: number]> = [
  ["claude-", 200000],
  ["gemini-", 1048576],
  ["gpt-3.5", 16384],
  ["gpt-4-turbo", 128000],
  ["gpt-4o", 128000],
  ["gpt-4.1", 1048576],
  ["o1-", 200000],
  ["o3-", 200000],
  ["o4-", 200000],
  ["gpt-5", 400000],
  ["deepseek-v4", 1048576], // deepseek-v4 系官方 1M（v4-flash/v4-pro，DeepSeek API 文档 + pi 官方目录）
  ["deepseek-", 65536], // v3/r1 系 64K
  ["moonshot-", 128000],
  ["kimi-", 128000],
  ["qwen-", 131072],
  ["glm-", 128000],
  ["mistral-", 131072],
  ["llama-", 131072],
  ["grok-", 131072],
  ["command-", 131072],
];

// 按前缀长度降序，保证"最长前缀命中优先"。
const CONTEXT_RULES_BY_LONGEST = [...CONTEXT_RULES].sort((a, b) => b[0].length - a[0].length);

/** 根据模型 id 推断上下文窗口（token 数）。匹配不区分大小写，
 * vendor 前缀（"org/model-id"）只匹配最后一个 "/" 之后的部分。 */
export function inferContextWindow(modelId: string): number {
  const normalized = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  for (const [prefix, contextWindow] of CONTEXT_RULES_BY_LONGEST) {
    if (normalized.startsWith(prefix)) return contextWindow;
  }
  return 128000;
}

/**
 * 模型级 API 推断：部分聚合端对 gpt-5 系在 /v1/chat/completions 拒绝 function tools
 * （400: use /v1/responses），必须走 openai-responses。其余家族返回 undefined
 * （跟随 provider 级 api）。
 */
export function inferModelApi(modelId: string): string | undefined {
  const fam = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  if (/^gpt-5/.test(fam)) return "openai-responses";
  return undefined;
}

/**
 * 读取 pi 官方模型目录缓存（~/.pi/agent/models-store.json，pi 从 pi.dev 每 4 小时
 * 刷新一次）：按模型 id 提供官方 contextWindow/maxTokens/reasoning/api。这是
 * 权威数据源（pi 登录官方供应商即用它自动配置模型）；中转站模型 id 与官方一致。
 */
export interface PiCatalogEntry {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  api?: string;
  /** 官方思考等级映射（如 deepseek-v4 仅 high/max；kimi-k3 无 xhigh） */
  thinkingLevelMap?: Record<string, string | null>;
  /** 官方兼容参数（thinkingFormat、supportsReasoningEffort 等模型行为） */
  compat?: Record<string, unknown>;
}

const _piCatalog: { map: Map<string, PiCatalogEntry>; path: string } = { map: new Map(), path: "" };

export function loadPiModelCatalog(storePath?: string): Map<string, PiCatalogEntry> {
  const path = storePath ?? join(agentDir(), "models-store.json");
  if (_piCatalog.path === path) return _piCatalog.map;
  _piCatalog.path = path;
  _piCatalog.map = new Map();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, { models?: unknown[] }>;
    for (const provider of Object.values(data)) {
      for (const m of provider.models ?? []) {
        if (typeof m !== "object" || m === null) continue;
        const entry = m as Record<string, unknown>;
        const id = typeof entry.id === "string" ? entry.id : "";
        if (!id) continue;
        const out: PiCatalogEntry = {};
        if (typeof entry.contextWindow === "number") out.contextWindow = entry.contextWindow;
        if (typeof entry.maxTokens === "number") out.maxTokens = entry.maxTokens;
        if (typeof entry.reasoning === "boolean") out.reasoning = entry.reasoning;
        if (typeof entry.api === "string") out.api = entry.api;
        if (typeof entry.thinkingLevelMap === "object" && entry.thinkingLevelMap !== null) {
          const tlm: Record<string, string | null> = {};
          for (const [k, v] of Object.entries(entry.thinkingLevelMap as Record<string, unknown>)) {
            if (v === null || typeof v === "string") tlm[k] = v as string | null;
          }
          if (Object.keys(tlm).length > 0) out.thinkingLevelMap = tlm;
        }
        if (typeof entry.compat === "object" && entry.compat !== null) {
          out.compat = entry.compat as Record<string, unknown>;
        }
        _piCatalog.map.set(id, out);
      }
    }
  } catch {
    // 无缓存或不可读：规则兜底
  }
  return _piCatalog.map;
}

/**
 * 思考能力推断（官方目录未命中时兜底）：主流思考模型家族 → true。
 * 与 inferModelApi 同理，官方目录（pi 登录供应商自动拉取）优先，这里只兜底。
 */
export function inferReasoning(modelId: string): boolean {
  const fam = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  if (/^(gpt-5|o[134]-|claude-|gemini-|deepseek-|kimi-|moonshot-|qwen-|glm-|mistral-|llama-|grok-|command-)/.test(fam)) return true;
  return false;
}

export async function fetchGatewayModels(
  baseUrl: string,
  key: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; catalogStorePath?: string } = {},
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
    .map((raw) => {
      const id = typeof raw.id === "string" ? raw.id : "";
      const official = id !== "" ? loadPiModelCatalog(options.catalogStorePath).get(id) : undefined;
      return {
        id,
        name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : undefined,
        input: ["text"] as GatewayModel["input"],
        contextWindow: id !== "" ? (official?.contextWindow ?? inferContextWindow(id)) : undefined,
        maxTokens: id !== "" ? official?.maxTokens : undefined,
        reasoning: id !== "" ? (official?.reasoning ?? inferReasoning(id)) : undefined,
        // 官方目录标注的 api 优先（如 kimi k3 官方 anthropic-messages）；
        // 其余用家族推断（gpt-5 系 → openai-responses，实测中转站必需）
        api: id !== "" ? (official?.api ?? inferModelApi(id)) : undefined,
        // 思考等级映射与 compat 仅来自官方目录（pi.dev 权威值，如 deepseek 的
        // thinkingFormat、kimi 无 xhigh 等）；目录未命中则省略，pi 按默认处理
        thinkingLevelMap: id !== "" ? official?.thinkingLevelMap : undefined,
        compat: id !== "" ? official?.compat : undefined,
      };
    })
    .filter((m) => m.id !== "");
}
