import { describe, expect, it } from "vitest";
import { formatSyncStatus, type SaveState } from "../src/save-state.ts";

const base: SaveState = {};

describe("formatSyncStatus 状态文案", () => {
  it("lastPush ok 且无未推送 → 已同步", () => {
    const s: SaveState = {
      lastArchive: { time: "2026-08-01T03:00:00Z", session: "x.jsonl", result: "committed" },
      lastPush: { time: "2026-08-01T03:01:00Z", result: "ok" },
    };
    expect(formatSyncStatus(s, 0)).toContain("✓ 已同步");
  });

  it("有未推送提交 → ⚠ N 个未推送（优先于已同步）", () => {
    const s: SaveState = { lastPush: { time: "2026-08-01T03:01:00Z", result: "ok" } };
    expect(formatSyncStatus(s, 3)).toBe("⚠ 3 个未推送");
  });

  it("上次推送失败 → ✗", () => {
    const s: SaveState = {
      lastPush: { time: "2026-08-01T01:00:00Z", result: "failed", error: "403" },
    };
    expect(formatSyncStatus(s, 0)).toContain("✗ 上次推送失败");
  });

  it("无任何记录 → 尚无保存记录", () => {
    expect(formatSyncStatus(base, null)).toContain("尚无保存记录");
  });
});
