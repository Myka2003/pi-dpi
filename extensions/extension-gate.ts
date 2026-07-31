/**
 * extension-gate：per-agent 扩展/技能加载的启动自愈门闸。
 *
 * 机制：
 * 1. 扩展隔离：pi 的 settings.json packages 条目支持
 *    { source, extensions: [...] } 对象形式，extensions 是白名单过滤器（按包内
 *    相对路径匹配），过滤发生在 jiti import 之前——被过滤的扩展文件根本不会执行。
 *    本扩展在 session_start 时调用 syncExtensionFilter(loadConfig())，把
 *    settings.json 里内容包条目的过滤器重写为当前 agent 在 agent.json.extensions
 *    中声明的白名单。
 * 2. 技能严格模式：pi 会自动发现 ~/.pi/agent/skills、~/.agents/skills、项目
 *    .agents/skills 的技能并全部启用（settings.skills 缺省时）。为让装了 dpi 的
 *    agent 技能严格由 agent.json 声明决定（经 resources_discover 注入），把
 *    settings.skills 置为 ["!*"] 禁用全部自动发现来源。
 *
 * 边界：改写 settings.json 后，要下一次 ctx.reload()（或重启 pi）重读 settings
 * 才生效——事件 hook 的 ctx 没有 reload，本次会话维持现状；启动自愈的意义在于
 * agent.json 被外部编辑/同步（/sync 拉取）后，过滤器也能在下一次重载后收敛。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureRepoDeps, loadConfig, syncExtensionFilter, syncStrictSkills } from "../src/config.ts";

export default function (pi: ExtensionAPI) {
  // 启动自愈：内容仓库依赖安装 + 扩展过滤器对齐 agent 声明 + 技能严格模式
  // （均幂等，无改动不写盘；依赖安装阻塞式保证本次会话扩展可用）
  pi.on("session_start", async () => {
    const cfg = loadConfig();
    if (cfg.repoUrl) ensureRepoDeps(cfg.repoPath);
    syncExtensionFilter(cfg);
    syncStrictSkills();
  });
}
