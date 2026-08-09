/**
 * command-alias：命令注册辅助——统一 /dpi-<name> 前缀命名。
 *
 * 命令只保留 /dpi- 前缀名（旧 alias 已移除），避免与别的包命令冲突、
 * 保证命令命名空间清晰；统一控制台 /dpi 除外（Task 4）。入口名固定带 dpi-
 * 前缀（类型约束），console 命令名放宽为 "dpi"。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CommandSpec {
  description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

/** 注册 /dpi-<name> 命令（name 带 dpi- 前缀，类型约束防拼错）；统一控制台 /dpi 除外 */
export function registerDpiCommand(
  pi: ExtensionAPI,
  name: `dpi-${string}` | "dpi",
  spec: CommandSpec,
): void {
  pi.registerCommand(name, spec);
}
