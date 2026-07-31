/**
 * command-alias：命令注册辅助——统一 /dpi-<name> 前缀命名。
 *
 * 命令只保留 /dpi- 前缀名（旧 alias 已移除），避免与别的包命令冲突、
 * 保证命令命名空间清晰。入口名固定带 dpi- 前缀（类型约束）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CommandSpec {
  description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

/** 注册 /dpi-<name> 命令（name 带 dpi- 前缀，类型约束防拼错） */
export function registerDpiCommand(
  pi: ExtensionAPI,
  name: `dpi-${string}`,
  spec: CommandSpec,
): void {
  pi.registerCommand(name, spec);
}
