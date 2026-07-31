/**
 * vim-list-picker：泛型 vim 风格列表选择器（ctx.ui.custom 组件）。
 *
 * 取代 pi 的 ctx.ui.select（不支持滚动/搜索，条目多时撑爆终端）。
 * 按键表（笔记本友好：全部无物理 PgUp/PgDn 也能用）：
 *   j/↓ 下移 · k/↑ 上移 · gg 首页 · G 末页
 *   ^D/^U 半页 · ^F/^B 整页 · PgUp/PgDn/空格 整页（兼容台式键盘）
 *   / 过滤（子串匹配 label，Enter 确认，Esc 清空退出）
 *   select 模式：Enter 选中（光标项）；Esc/q/^C 取消
 *   toggle 模式：Space/Enter 切换当前项勾选（●/○），Esc/q/^C 完成返回勾选集
 *   自定义动作键：actions 声明（如 d=删除），按下即结束并返回当前项
 *
 * 导航状态（VimListState）抽为纯类便于单测；组件只做渲染与按键分发。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** 列表项：id 稳定定位，label 主文本，meta 右侧后缀，checked 仅 toggle 模式有意义 */
export interface VimListItem<T> {
  id: string;
  label: string;
  meta?: string;
  checked?: boolean;
  data: T;
}

export interface VimListAction {
  /** 触发键（单个字符或组合键 id，如 "d"） */
  key: string;
  /** 动作 id，结果里原样返回 */
  id: string;
  /** 底栏提示文案 */
  hint: string;
}

export interface VimListResult<T> {
  /** "pick"（select 模式选中）/ "cancel" / 自定义动作 id */
  action: string;
  item?: VimListItem<T>;
  /** toggle 模式最终勾选的 id 集（取消时也是当前集） */
  checked?: string[];
}

/** 主题最小接口（pi 的 Theme 类型未导出，结构适配） */
export interface ThemeLike {
  fg(color: string, text: string): string;
}

export interface VimListPickerOptions<T> {
  title: string;
  items: VimListItem<T>[];
  mode: "select" | "toggle";
  /** 初始光标定位的项 id（如当前 agent） */
  initialId?: string;
  /** 自定义动作键（select/toggle 均生效） */
  actions?: VimListAction[];
  /** 覆盖底栏提示 */
  hint?: string;
  theme: ThemeLike;
  onResult(result: VimListResult<T>): void;
}

/**
 * 导航状态纯类（可单测）：分页/过滤/跳转/勾选，不依赖 TUI。
 */
export class VimListState<T> {
  private items: VimListItem<T>[];
  private pageSize: number;
  private filterText = "";
  private pageOffset = 0;
  private sel = 0;
  private checked: Set<string>;

  constructor(items: VimListItem<T>[], pageSize: number, initialId?: string) {
    this.items = items;
    this.pageSize = pageSize;
    this.checked = new Set(
      items.filter((i) => i.checked).map((i) => i.id),
    );
    if (initialId) {
      const idx = this.items.findIndex((i) => i.id === initialId);
      if (idx >= 0) {
        this.pageOffset = Math.floor(idx / pageSize) * pageSize;
        this.sel = idx % pageSize;
      }
    }
  }

  /** 过滤后的全量可见列表（filter 子串匹配 label，大小写不敏感） */
  visible(): VimListItem<T>[] {
    const f = this.filterText.trim().toLowerCase();
    return f
      ? this.items.filter((i) => i.label.toLowerCase().includes(f))
      : this.items;
  }

  /** 当前页条目 */
  page(): VimListItem<T>[] {
    return this.visible().slice(this.pageOffset, this.pageOffset + this.pageSize);
  }

  /** 页内游标 */
  selectedIndex(): number {
    return this.sel;
  }

  /** 页码信息：起始-结束/总数 */
  pageInfo(): string {
    const total = this.visible().length;
    if (total === 0) return "0";
    const start = this.pageOffset + 1;
    const end = Math.min(this.pageOffset + this.page().length, total);
    return total > this.pageSize ? `${start}-${end}/${total}` : `${total}`;
  }

  /** 当前过滤词（渲染标题用） */
  filter(): string {
    return this.filterText;
  }

  setFilter(f: string): void {
    this.filterText = f;
    this.pageOffset = 0;
    this.sel = 0;
  }

  private clampSel(): void {
    const pageLen = this.page().length;
    if (this.sel >= pageLen && pageLen > 0) this.sel = pageLen - 1;
  }

  moveDown(): void {
    const v = this.visible();
    if (v.length === 0) return;
    const pageLen = this.page().length;
    if (this.sel < pageLen - 1) {
      this.sel++;
    } else if (this.pageOffset + this.pageSize < v.length) {
      this.pageOffset += this.pageSize;
      this.sel = 0; // 翻页后光标在新页首（视觉上的下一项）
    }
  }

  moveUp(): void {
    if (this.sel > 0) {
      this.sel--;
    } else if (this.pageOffset > 0) {
      this.pageOffset -= this.pageSize;
      this.sel = this.pageSize - 1; // 页首继续上移 → 上一页末项
      this.clampSel();
    }
  }

  /** 半页移动（vim ^D/^U） */
  moveHalf(down: boolean): void {
    if (this.visible().length === 0) return;
    const step = Math.max(1, Math.floor(this.pageSize / 2));
    for (let i = 0; i < step; i++) down ? this.moveDown() : this.moveUp();
  }

  /** 整页移动（vim ^F/^B / PgDn/PgUp） */
  movePage(down: boolean): void {
    const v = this.visible();
    if (v.length === 0) return;
    if (down) {
      if (this.pageOffset + this.pageSize < v.length) this.pageOffset += this.pageSize;
    } else {
      this.pageOffset = Math.max(0, this.pageOffset - this.pageSize);
    }
    this.clampSel();
  }

  /** 跳到第一页第一项 / 最后一页最后一项（gg / G） */
  jump(first: boolean): void {
    const v = this.visible();
    if (v.length === 0) return;
    if (first) {
      this.pageOffset = 0;
      this.sel = 0;
    } else {
      const lastPageStart = Math.floor((v.length - 1) / this.pageSize) * this.pageSize;
      this.pageOffset = lastPageStart;
      this.sel = v.length - 1 - lastPageStart;
    }
  }

  /** toggle 模式：切换当前项勾选 */
  toggleCurrent(): void {
    const p = this.page();
    const item = p[this.sel];
    if (!item) return;
    if (this.checked.has(item.id)) this.checked.delete(item.id);
    else this.checked.add(item.id);
  }

  isChecked(id: string): boolean {
    return this.checked.has(id);
  }

  checkedIds(): string[] {
    return [...this.checked];
  }
}

export class VimListPicker<T> implements Component {
  private state: VimListState<T>;
  private opts: VimListPickerOptions<T>;
  private lastKey = ""; // gg 组合键检测
  private mode: "nav" | "search" = "nav";

  constructor(opts: VimListPickerOptions<T>) {
    this.opts = opts;
    this.state = new VimListState(opts.items, 20, opts.initialId);
  }

  private finish(action: string): void {
    this.opts.onResult({
      action,
      item: this.state.page()[this.state.selectedIndex()],
      checked: this.state.checkedIds(),
    });
  }

  handleInput(data: string): void {
    const actions = this.opts.actions ?? [];
    const action = actions.find((a) => data === a.key); // 动作键均为单字符，直接比较
    if (action && this.mode === "nav") {
      this.finish(action.id);
      return;
    }

    // 搜索模式：可打印字符输入 / 退格 / 回车确认 / Esc 清空退出
    if (this.mode === "search") {
      if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.state.setFilter(this.state.filter() + data);
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.state.setFilter(this.state.filter().slice(0, -1));
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.mode = "nav"; // 确认过滤（保留 filter）
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.state.setFilter("");
        this.mode = "nav";
      }
      return;
    }

    // 导航模式
    if (matchesKey(data, Key.down) || data === "j") return this.state.moveDown();
    if (matchesKey(data, Key.up) || data === "k") return this.state.moveUp();
    if (matchesKey(data, Key.pageDown) || data === " ") return this.state.movePage(true);
    if (matchesKey(data, Key.pageUp)) return this.state.movePage(false);
    if (matchesKey(data, Key.ctrl("d"))) return this.state.moveHalf(true);
    if (matchesKey(data, Key.ctrl("u"))) return this.state.moveHalf(false);
    if (matchesKey(data, Key.ctrl("f"))) return this.state.movePage(true);
    if (matchesKey(data, Key.ctrl("b"))) return this.state.movePage(false);
    if (data === "g") {
      if (this.lastKey === "g") {
        this.state.jump(true);
        this.lastKey = "";
      } else {
        this.lastKey = "g";
      }
      return;
    }
    this.lastKey = "";
    if (data === "G") return this.state.jump(false);
    if (data === "/") {
      this.mode = "search";
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.opts.mode === "select") {
        this.finish("pick");
      } else {
        this.state.toggleCurrent(); // Enter 也切换（vim 空格/回车语义）
      }
      return;
    }
    if (data === " ") {
      if (this.opts.mode === "toggle") this.state.toggleCurrent();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.finish("cancel");
    }
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const state = this.state;
    const page = state.page();
    const lines: string[] = [];

    // 标题行：模式 + 页码 + 过滤词
    const title =
      this.mode === "search"
        ? `${this.opts.title} /${state.filter()}▏`
        : `${this.opts.title}（${state.pageInfo()}）`;
    lines.push(t.fg("accent", title.slice(0, width)));

    // 列表
    if (page.length === 0) {
      lines.push(t.fg("dim", "  无匹配项（/ 清空过滤）"));
    } else {
      for (let i = 0; i < page.length; i++) {
        const item = page[i];
        const mark =
          this.opts.mode === "toggle" ? (state.isChecked(item.id) ? "● " : "○ ") : "";
        const meta = item.meta ? ` · ${item.meta}` : "";
        const body = `${mark}${item.label}${meta}`;
        if (i === state.selectedIndex()) {
          lines.push(t.fg("accent", `→ ${body}`).slice(0, width));
        } else {
          lines.push(t.fg("text", `  ${body}`).slice(0, width));
        }
      }
    }

    // 底栏
    const hint =
      this.opts.hint ??
      (this.mode === "search"
        ? "过滤输入中… Enter 确认 · Esc 清空退出"
        : this.opts.mode === "toggle"
          ? "j/k · ^D/^U ^F/^B · gg/G · / 过滤 · 空格/Enter 切换 · Esc 完成" +
            (this.opts.actions?.length ? ` · ${this.opts.actions.map((a) => `${a.key} ${a.hint}`).join(" · ")}` : "")
          : "j/k · ^D/^U ^F/^B · gg/G · / 过滤 · Enter 选择 · Esc 取消");
    lines.push(t.fg("dim", hint.slice(0, width)));
    return lines;
  }

  invalidate(): void {
    // 无缓存渲染
  }
}

/** 打开 vim 选择器，返回结果；TUI 不可用时（RPC/print）返回 undefined */
export function showVimListPicker<T>(
  ctx: ExtensionCommandContext,
  opts: Omit<VimListPickerOptions<T>, "theme" | "onResult">,
): Promise<VimListResult<T> | undefined> {
  return ctx.ui.custom<VimListResult<T>>(
    (_tui, theme, _keybindings, done) =>
      new VimListPicker<T>({
        ...opts,
        theme: theme as ThemeLike,
        onResult: (r) => done(r),
      }),
  );
}
