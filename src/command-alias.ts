/**
 * command-alias：命令双注册辅助——/dpi-<name> 正式名 + /<name> 旧 alias。
 *
 * pi 的 registerCommand 每次注册独立命令名，同一 handler 可注册多次；
 * alias 仅保留旧名可用（1.0 前移除），description 标注引导用新名。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CommandSpec {
  description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * 注册 /dpi-<name>（正式）与 /<name>（alias）。
 * 入参 name 带 dpi- 前缀（如 "dpi-sessions"），alias 自动去前缀。
 */
export function registerDpiCommand(
  pi: ExtensionAPI,
  name: `dpi-${string}`,
  spec: CommandSpec,
): void {
  pi.registerCommand(name, spec);
  const legacy = name.slice("dpi-".length);
  pi.registerCommand(legacy, {
    ...spec,
    description: `旧名 alias（已改名 /${name}）；${spec.description}`,
  });
}
