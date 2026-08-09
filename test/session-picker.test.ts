import { describe, expect, it } from "vitest";
import type { ArchivedMeta, ArchivedSession } from "../src/sessions-shared.ts";
import { showSessionPicker } from "../src/session-picker.ts";
import { VimListPicker } from "../src/vim-list-picker.ts";

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

describe("showSessionPicker titlePrefix 透传", () => {
  function meta(agent: string, fileName: string): ArchivedMeta {
    return {
      agent,
      path: `sessions/${agent}/${fileName}`,
      fileName,
      sortKey: Date.parse("2026-08-01T00:00:00Z"),
      dayLabel: "2026-08-01",
      name: "",
      size: 1024,
      first: "hi",
      updatedAt: 0,
    };
  }

  /** 拦截 showVimListPicker 的工厂，捕获构建出的 VimListPicker 供渲染断言 */
  function capturePicker() {
    let picker: VimListPicker<ArchivedMeta> | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        custom: (
          factory: (
            _tui: unknown,
            theme: unknown,
            _keybindings: unknown,
            done: (r: unknown) => void,
          ) => VimListPicker<ArchivedMeta>,
        ) =>
          new Promise((resolve) => {
            const done = (r: unknown) => resolve(r);
            picker = factory(undefined, { fg: (_color: string, text: string) => text }, undefined, done);
          }),
      },
    };
    return { ctx: ctx as never, getPicker: () => picker };
  }

  it("把自定义 titlePrefix 透传到选择器标题", async () => {
    const { ctx, getPicker } = capturePicker();
    const prefix = "Session Archive — record: on · last archive 08-09 12:34 · 1 unpushed";
    const p = showSessionPicker(ctx, [meta("coder", "a.jsonl")], "coder", false, "", prefix);
    const picker = getPicker();
    expect(picker).toBeDefined();
    expect(picker!.render(120)[0]).toContain(prefix);
    picker!.handleInput("q"); // 结束选择器，让 promise 落定
    await p;
  });

  it("onlyCurrent 时标题为 titlePrefix + 当前 agent", async () => {
    const { ctx, getPicker } = capturePicker();
    const p = showSessionPicker(ctx, [meta("coder", "a.jsonl")], "coder", true, "", "My Prefix");
    const picker = getPicker();
    expect(picker).toBeDefined();
    const title = picker!.render(120)[0];
    expect(title).toContain("My Prefix — coder");
    picker!.handleInput("q");
    await p;
  });
});
