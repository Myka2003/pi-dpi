All verification complete. Compiling the review.

## Review: uniform-thinking-map refactor (a950b464..340e6893)

### Spec Compliance

**1. PiCatalogEntry no longer carries thinkingLevelMap/compat; loader no longer parses them — ✅ CONFIRMED**
`src/gateway-catalog.ts` interface now has only `contextWindow`, `maxTokens`, `reasoning`, `api`. `loadPiModelCatalog` parses exactly those four fields; the `thinkingLevelMap`/`compat` extraction blocks were removed. No other file references `PiCatalogEntry.thinkingLevelMap`/`.compat` (grep over `src/` finds only the `GatewayModel` optional fields and profile schema validator, which are unrelated and still valid).

**2. fetchGatewayModels assigns uniform STANDARD_THINKING_LEVEL_MAP and does NOT pass compat; reasoning unchanged — ✅ CONFIRMED**
- `STANDARD_THINKING_LEVEL_MAP = { low: "low", medium: "medium", high: "high", max: "max" }` exported.
- Every model with `id !== ""` gets `thinkingLevelMap: STANDARD_THINKING_LEVEL_MAP`; no `compat` field is set (verified in source, line ~166).
- Reasoning still `official?.reasoning ?? inferReasoning(id)` — unchanged.
- `compat` passthrough fully removed; downstream `gateway-projection.ts`/schema still handle optional `compat`/`thinkingLevelMap`, so the removal is type-consistent.

**3. Test updated; suite green; typecheck clean; version not bumped; only two files changed — ✅ CONFIRMED**
- Test rewritten: `"standard thinking level map"` asserts every model (deepseek-v4-flash + babbage-002, one reasoning-family and one non-reasoning) gets `thinkingLevelMap === STANDARD_THINKING_LEVEL_MAP` and `compat === undefined`; old passthrough test removed.
- `vitest run`: **223 passed / 27 files**.
- `tsc --noEmit` (global `/usr/local/bin/tsc`, as the repo's `typecheck` script resolves): **exit 0, clean**.
- `package.json` version `0.8.50` at both `a950b464` and `340e6893` — not bumped.
- `git diff --stat a950b464..340e6893`: exactly `src/gateway-catalog.ts` + `test/gateway-catalog.test.ts`, 22 insertions / 34 deletions.

### Issues

#### Critical
None.

#### Important
None.

#### Minor
- **`src/gateway-catalog.ts:147-151`** — doc-comment misattachment: the `/** 思考能力推断（官方目录未命中时兜底）… */` comment that documents `inferReasoning` was separated from the function by the inserted `STANDARD_THINKING_LEVEL_MAP` const; it now dangles above the const's own doc comment. Cosmetic only.
- **`src/gateway-catalog.ts:151-156`** — the exported `STANDARD_THINKING_LEVEL_MAP` is a mutable object shared by reference across every model's `thinkingLevelMap`. Benign today (nothing in the repo mutates it; projection only serializes it), but a `Readonly`/`as const` or `Object.freeze` would harden it against accidental in-place mutation.
- **Test coverage** — the new test doesn't exercise the "official catalog contains thinkingLevelMap/compat → ignored" path (no `catalogStorePath`). Since the loader no longer parses those fields at all, the behavior is structurally guaranteed; a future re-introduction of per-model parsing without a test would go unnoticed. Low risk.

**Observation (not part of the reviewed commit):** the working tree has an uncommitted `package-lock.json` drift (`0.8.49` → `0.8.50` in the lockfile, HEAD still at `0.8.49`). It predates/exists outside the reviewed range (which touched only the two files) and is unstaged. Nothing to fix in this review, but the tree is not fully pristine.

### Assessment
**Approved.** The refactor does exactly what the task brief claims: uniform `{low,medium,high,max}` thinking-level map for every gateway model, no official `compat` passthrough, reasoning priority untouched, catalog interface/loader slimmed, tests updated and green (223), typecheck clean, version unchanged, and only the two intended files in the commit. Only cosmetic/minor notes; no functional defects found.