/**
 * session-picker：/dpi-sessions 的 vim 风格会话选择器（VimListPicker 的会话专用包装）。
 *
 * - 条目来自 git 元数据（ArchivedMeta）：label = [agent] 文件名，meta = 大小——
 *   不下载内容（名字由调用方选中后懒加载）
 * - select 模式：Enter 选中返回会话
 * - c 键：切换 agent 筛选（自定义动作，返回 "cycle-filter"，由调用方重开选择器）
 * - 分页/过滤/翻页按键由 VimListPicker 提供（j/k、gg/G、^D/^U ^F/^B、/ 过滤）
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ArchivedMeta } from "./sessions-shared.ts";
import { formatShortDate } from "./sessions-shared.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

/** 大小格式化：12.3MB / 1.2KB / - */
function fmtSize(size: number): string {
  if (size <= 0) return "-";
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(size / 1024))}KB`;
}

/** 选择结果：会话 | "cycle-filter"（要求切换 agent 筛选后重开） | undefined（取消） */
export type SessionPickerResult = ArchivedMeta | "cycle-filter" | undefined;

/** 打开 vim 会话选择器；entries 已按时间倒序（scanArchivedMeta），按 agent 预过滤 */
export function showSessionPicker(
  ctx: ExtensionCommandContext,
  entries: ArchivedMeta[],
  currentAgent: string,
  onlyCurrent: boolean,
  currentSessionFile = "",
): Promise<SessionPickerResult> {
  // KISS 布局：大小紧跟 agent（永远可见），标题用名字或短日期（不显示长文件名），
  // 当前会话置顶项加 * 标记（视觉区分）
  const items: VimListItem<ArchivedMeta>[] = entries
    .filter((s) => !onlyCurrent || s.agent === currentAgent)
    .map((s) => {
      const isCurrent = currentSessionFile !== "" && s.fileName === currentSessionFile;
      const title = s.name ? s.name : s.first ? s.first : formatShortDate(s.fileName);
      return {
        id: s.fileName, // 文件名唯一，作稳定 id
        label: `${isCurrent ? "* " : "  "}[${s.agent}] ${fmtSize(s.size)} · ${title}`,
        meta: isCurrent ? "current" : undefined,
        data: s,
      };
    });

  return showVimListPicker(ctx, {
    title: onlyCurrent ? `Session Archive — ${currentAgent}` : "Session Archive",
    items,
    mode: "select",
    actions: [{ key: "c", id: "cycle-filter", hint: "c filter" }],
  }).then((res) => {
    if (!res) return undefined;
    if (res.action === "cycle-filter") return "cycle-filter";
    if (res.action === "pick" && res.item) return res.item.data;
    return undefined;
  });
}
