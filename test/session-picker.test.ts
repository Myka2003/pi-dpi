import { describe, expect, it } from "vitest";
import type { ArchivedMeta, ArchivedSession } from "../src/sessions-shared.ts";

// 不直接依赖 TUI 组件实例化（handleInput 需要 Key 对象），
// 这里验证 picker 的核心可见列表语义：过滤 + agent 筛选 + 排序
import { entryTitle } from "../src/sessions-shared.ts";

function mk(agent: string, day: string, cwd: string, msg: string, sortKey: number): ArchivedSession {
  return {
    agent, path: `/x/${agent}/${day}.jsonl`, fileName: `${day}.jsonl`,
    name: "", firstUser: msg, messages: 2, sortKey,
    dayLabel: day, cwdLabel: cwd, partial: false,
  };
}

describe("ArchivedMeta 时间字段", () => {
  it("保留最后更新时间并可回退到文件名时间", () => {
    const meta: ArchivedMeta = {
      agent: "coder",
      path: "sessions/coder/x.jsonl",
      fileName: "2026-08-01T00-00-00-000Z_x.jsonl",
      sortKey: Date.parse("2026-08-01T00:00:00Z"),
      dayLabel: "2026-08-01",
      name: "",
      size: 1,
      first: "hi",
      updatedAt: Date.parse("2026-08-01T00:09:00Z"),
    };
    expect(meta.updatedAt).toBe(Date.parse("2026-08-01T00:09:00Z"));
    expect(meta.updatedAt || meta.sortKey).toBe(Date.parse("2026-08-01T00:09:00Z"));
  });
});

describe("entryTitle 固定格式", () => {
  it("name 优先", () => {
    const s = mk("coder", "2026-07-28", "HomeLab", "你好", 1);
    s.name = "自定义标题";
    expect(entryTitle(s)).toBe("自定义标题");
  });
  it("无 name 时 MM-DD 目录 · 首条消息", () => {
    const s = mk("coder", "2026-07-28", "HomeLab", "看下这个目录的项目", 1);
    expect(entryTitle(s)).toBe("07-28 HomeLab · 看下这个目录的项目");
  });
  it("首条消息为空时只有日期+目录", () => {
    const s = mk("claude", "2026-07-16", "nixos", "", 1);
    expect(entryTitle(s)).toBe("07-16 nixos");
  });
});
