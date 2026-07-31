/**
 * session-picker：/sessions 的 vim 风格选择器（ctx.ui.custom 组件）。
 *
 * pi 的 ctx.ui.select 不支持滚动/搜索（ExtensionSelectorComponent 全量渲染），
 * 条目多时把终端撑满。本组件自绘列表并提供 vim 导航：
 *   j/↓ 下移 · k/↑ 上移 · gg 首页 · G 末页 · PgUp/PgDn 翻页
 *   / 进入过滤（可打印字符输入，Enter 确认，Esc 清空退出）
 *   c 切换 agent 筛选 · Enter 选中 · Esc/q 取消
 *
 * 组件只负责「选一个会话」，恢复/删除子菜单仍由 session-browser 用 select 处理。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { entryTitle, relTime, truncate, type ArchivedSession } from "./sessions-shared.ts";

// 每页条数（列表高度上限，避免撑爆终端）
const PAGE_SIZE = 20;

/** Theme 最小接口（pi 的 Theme 类型未导出，用结构适配） */
interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

export interface SessionPickerOptions {
  entries: ArchivedSession[];
  currentAgent: string;
  theme: ThemeLike;
  /** 选中一个会话（返回后由调用方做恢复/删除子菜单） */
  onPick(s: ArchivedSession): void;
  onCancel(): void;
}

export class SessionPicker implements Component {
  private entries: ArchivedSession[];
  private currentAgent: string;
  private theme: ThemeLike;
  private onPick: (s: ArchivedSession) => void;
  private onCancel: () => void;

  private mode: "nav" | "search" = "nav";
  private filter = ""; // / 过滤词（子串匹配 entryTitle，大小写不敏感）
  private onlyCurrent = false; // c 切换：全部 / 当前 agent
  private pageOffset = 0;
  private sel = 0; // 页内选中
  private lastKey = ""; // gg 组合键检测

  constructor(opts: SessionPickerOptions) {
    this.entries = opts.entries;
    this.currentAgent = opts.currentAgent;
    this.theme = opts.theme;
    this.onPick = opts.onPick;
    this.onCancel = opts.onCancel;
  }

  /** 过滤 + 排序后的全量可见列表（vim 的 :g 语义：filter 是全局过滤） */
  private visible(): ArchivedSession[] {
    const f = this.filter.trim().toLowerCase();
    return this.entries
      .filter((s) => !this.onlyCurrent || s.agent === this.currentAgent)
      .filter((s) => !f || entryTitle(s).toLowerCase().includes(f))
      .sort((a, b) => b.sortKey - a.sortKey);
  }

  /** 当前页条目 */
  private page(): ArchivedSession[] {
    const v = this.visible();
    return v.slice(this.pageOffset, this.pageOffset + PAGE_SIZE);
  }

  /** 页码信息：起始-结束/总数；过滤时前缀 /词 */
  private pageInfo(): string {
    const total = this.visible().length;
    const start = total === 0 ? 0 : this.pageOffset + 1;
    const end = Math.min(this.pageOffset + this.page().length, total);
    const pos = total > PAGE_SIZE ? `${start}-${end}/${total}` : `${total}`;
    return this.filter ? `/${this.filter} ${pos}` : pos;
  }

  private resetCursor(): void {
    this.pageOffset = 0;
    this.sel = 0;
  }

  private moveDown(): void {
    const v = this.visible();
    if (v.length === 0) return;
    const pageLen = this.page().length;
    if (this.sel < pageLen - 1) {
      this.sel++;
    } else if (this.pageOffset + PAGE_SIZE < v.length) {
      this.pageOffset += PAGE_SIZE; // 页尾继续下移 → 自动翻页
    }
  }

  private moveUp(): void {
    if (this.sel > 0) {
      this.sel--;
    } else if (this.pageOffset > 0) {
      this.pageOffset -= PAGE_SIZE;
      this.sel = PAGE_SIZE - 1; // 页首继续上移 → 上一页末项
    }
  }

  /** 跳到第一页第一项 / 最后一页最后一项（gg / G） */
  private jump(first: boolean): void {
    const v = this.visible();
    if (v.length === 0) return;
    if (first) {
      this.pageOffset = 0;
      this.sel = 0;
    } else {
      const lastPageStart = Math.floor((v.length - 1) / PAGE_SIZE) * PAGE_SIZE;
      this.pageOffset = lastPageStart;
      this.sel = v.length - 1 - lastPageStart;
    }
  }

  handleInput(data: string): void {
    // 搜索模式：可打印字符输入 / 退格 / 回车确认 / Esc 清空退出
    if (this.mode === "search") {
      if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.filter += data;
        this.resetCursor();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filter = this.filter.slice(0, -1);
        this.resetCursor();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.mode = "nav"; // 确认过滤（保留 filter）
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.filter = "";
        this.mode = "nav";
        return;
      }
      return;
    }

    // 导航模式
    if (matchesKey(data, Key.down) || data === "j") return this.moveDown();
    if (matchesKey(data, Key.up) || data === "k") return this.moveUp();
    if (matchesKey(data, Key.pageDown) || data === " ") return this.moveDown();
    if (matchesKey(data, Key.pageUp)) return this.moveUp();
    if (data === "g") {
      // gg：连按两次 g 回首页
      if (this.lastKey === "g") {
        this.jump(true);
        this.lastKey = "";
      } else {
        this.lastKey = "g";
      }
      return;
    }
    this.lastKey = "";
    if (data === "G") return this.jump(false);
    if (data === "/") {
      this.mode = "search"; // 保留既有 filter 继续追加
      return;
    }
    if (data === "c") {
      this.onlyCurrent = !this.onlyCurrent;
      this.resetCursor();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const p = this.page();
      if (p[this.sel]) this.onPick(p[this.sel]);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.onCancel();
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const page = this.page();
    const total = this.visible().length;
    const lines: string[] = [];

    // 标题行：模式 + 页码 + 筛选状态
    const title =
      this.mode === "search"
        ? `会话存档 /${this.filter}▏`
        : `会话存档（${this.pageInfo()}${this.onlyCurrent ? ` · ${this.currentAgent}` : ""}）`;
    lines.push(t.fg("accent", title.slice(0, width)));

    // 列表
    if (total === 0) {
      lines.push(t.fg("dim", "  无匹配的存档（/ 清空过滤）"));
    } else {
      for (let i = 0; i < page.length; i++) {
        const s = page[i];
        const body = `[${s.agent}] ${truncate(entryTitle(s), Math.max(20, width - 14))} · ${relTime(s.sortKey)}`;
        if (i === this.sel) {
          lines.push(t.fg("accent", `→ ${body}`).slice(0, width));
        } else {
          lines.push(t.fg("text", `  ${body}`).slice(0, width));
        }
      }
    }

    // 底栏：按键提示
    const hints =
      this.mode === "search"
        ? "过滤输入中… Enter 确认 · Esc 清空退出"
        : "j/k 导航 · gg 首页 · G 末页 · PgUp/PgDn 翻页 · / 过滤 · c 筛选 · Enter 选择 · Esc 取消";
    lines.push(t.fg("dim", hints.slice(0, width)));
    return lines;
  }

  invalidate(): void {
    // 无缓存渲染，无需处理
  }
}

/** 打开 vim 选择器，返回选中的会话；取消返回 undefined */
export function showSessionPicker(
  ctx: ExtensionCommandContext,
  entries: ArchivedSession[],
  currentAgent: string,
): Promise<ArchivedSession | undefined> {
  return ctx.ui.custom<ArchivedSession | undefined>(
    (_tui, theme, _keybindings, done) =>
      new SessionPicker({
        entries,
        currentAgent,
        theme: theme as ThemeLike,
        onPick: (s) => done(s),
        onCancel: () => done(undefined),
      }),
  );
}
