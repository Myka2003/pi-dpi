/**
 * session-picker：/sessions 的 vim 风格会话选择器（VimListPicker 的会话专用包装）。
 *
 * - 条目映射：VimListItem（label = [agent] 固定格式标题，meta = 消息数）
 * - select 模式：Enter 选中返回会话
 * - c 键：切换 agent 筛选（自定义动作，返回 "cycle-filter"，由调用方重开选择器）
 * - 分页/过滤/翻页按键由 VimListPicker 提供（j/k、gg/G、^D/^U ^F/^B、/ 过滤）
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { entryTitle, type ArchivedSession } from "./sessions-shared.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

/** 选择结果：会话 | "cycle-filter"（要求切换 agent 筛选后重开） | undefined（取消） */
export type SessionPickerResult = ArchivedSession | "cycle-filter" | undefined;

/** 打开 vim 会话选择器；entries 由调用方按 agent 预过滤（筛选在包装层） */
export function showSessionPicker(
  ctx: ExtensionCommandContext,
  entries: ArchivedSession[],
  currentAgent: string,
  onlyCurrent: boolean,
): Promise<SessionPickerResult> {
  const items: VimListItem<ArchivedSession>[] = entries
    .filter((s) => !onlyCurrent || s.agent === currentAgent)
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((s) => ({
      id: s.fileName, // 文件名唯一，作稳定 id
      label: `[${s.agent}] ${entryTitle(s)}`,
      meta: s.partial ? undefined : `${s.messages}条`,
      data: s,
    }));

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
