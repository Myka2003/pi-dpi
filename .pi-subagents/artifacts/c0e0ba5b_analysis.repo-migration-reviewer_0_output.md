All verification complete. Here is the review.

---

### Spec Compliance

Verified all four points against the actual commit `23c92fb8` (diff matches the review package exactly: 2 files, +79/−2):

1. **PiCatalogEntry gains `thinkingLevelMap` + `compat`** — ✅ Confirmed in `src/gateway-catalog.ts` (`thinkingLevelMap?: Record<string, string | null>`, `compat?: Record<string, unknown>`). Loader parses with type filtering: `thinkingLevelMap` values are kept only when `null` or `string` (non-string values silently dropped, empty map dropped); `compat` passed through as `Record<string, unknown>` when it is a non-null object.
2. **fetchGatewayModels merges official thinkingLevelMap/compat (catalog-only, no rule fallback)** — ✅ `thinkingLevelMap`/`compat` come only from `official?.x`; on catalog miss the result is `undefined` (omitted, pi uses defaults). No rule fallback exists for these two, as specified.
3. **reasoning uses `official ?? inferReasoning` family rule** — ✅ `reasoning: id !== "" ? (official?.reasoning ?? inferReasoning(id)) : undefined`. Official explicit `false` correctly overrides family inference — covered by test `"official reasoning wins over inference"`.
4. **inferReasoning regex coverage** — ✅ `/^(gpt-5|o[134]-|claude-|gemini-|deepseek-|kimi-|moonshot-|qwen-|glm-|mistral-|llama-|grok-|command-)/` matches every family in the spec. I ran a side-check: `gpt-5`, `o1-mini`, `o4-mini`, `o3-pro`, `claude-sonnet-4-5`, `gemini-2.5-pro`, `deepseek-v4-pro`, `kimi-k3`, `moonshot-v1`, `qwen-plus`, `glm-4.5`, `mistral-large`, `llama-3.3`, `grok-4`, `command-r-plus`, and vendor-prefixed `apimart/gpt-5.6-terra` → all `true`; `dall-e-3`, `babbage-002`, `text-embedding-3-large` → `false`. Vendor-prefix stripping (`lastIndexOf("/") + 1`) matches `inferContextWindow`/`inferModelApi` convention.
5. **Suite / typecheck / version / file scope** — ✅ `npx vitest run`: 27 files, **223/223 passed**. `/usr/local/bin/tsc --noEmit` (TS 5.7.2): clean, exit 0. Version unchanged `0.8.49` (same in parent `28696502`). `git diff --name-only 28696502 23c92fb8` → only `src/gateway-catalog.ts` + `test/gateway-catalog.test.ts`.

Downstream wiring verified: `GatewayModel` already declared `compat`/`thinkingLevelMap` (gateway-profile.ts, earlier commit), and `gateway-projection.ts` spreads them into the projected pi provider config — the passthrough is consumed end-to-end.

### Issues

#### Critical
None.

#### Important
None.

#### Minor
- **`src/gateway-catalog.ts:178` — `o[134]-` requires a trailing hyphen.** Bare ids `o1`/`o3`/`o4` (OpenAI's actual `o1` id has no suffix) return `false` from `inferReasoning`. Consistent with the existing `CONTEXT_RULES` convention (`o1-`/`o3-`/`o4-`), and the official catalog would supply `reasoning: true` for real o1, so the fallback gap only bites on catalog miss. `o2-` also uncovered (does not exist yet).
- **`test/gateway-catalog.test.ts` — temp store files** `/tmp/pi-models-store-test*.json` are written but never cleaned up. Harmless (each test overwrites its own path, and distinct paths avoid the module-level `_piCatalog` path-cache), just leaves stale files in `/tmp`.

Observations (not issues): `command- → true` is spec-mandated (task explicitly lists command → true) even though Cohere command-r models aren't thinking models; the `thinkingLevelMap` type filter silently drops non-`null|string` values, which is the intended filtering per spec.

### Assessment

**Approved.** The change is exactly scoped, spec-compliant on all four verification points, well-tested (including the important official-`false`-overrides-inference case and null-valued thinkingLevelMap keys), typecheck-clean, and does not bump the version. Only minor edge-case/cleanliness notes, no blockers.

Note: the working tree has an unrelated pre-existing `M package-lock.json` and untracked `.pi-subagents/artifacts/` files; neither is part of commit `23c92fb8`.