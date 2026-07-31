import { describe, expect, it } from "vitest";
import type { ArchivedSession } from "../src/sessions-shared.ts";

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
