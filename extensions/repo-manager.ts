/**
 * repo-manager：/dpi-repo 命令扩展——内容仓库状态、体检与修复。
 *
 * - status：本地只读体检（不发网络请求）
 * - doctor：带网络 dry-run fetch 的深度体检
 * - repair：修复远端/分支/稀疏模式，必要时重新 clone
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDpiCommand } from "../src/command-alias.ts";
import { inspectRepo, repairRepo, type RepoDoctorReport } from "../src/repo-doctor.ts";

function formatReport(report: RepoDoctorReport): string {
  return [
    `ok: ${report.ok}`,
    `remote: ${report.remoteUrl || "(missing)"}`,
    `branch: ${report.branch || "(missing)"}`,
    `head: ${report.head || "(missing)"}`,
    `dirty: ${report.dirty}`,
    ...(report.issues.length ? ["issues:", ...report.issues.map((issue) => `- ${issue}`)] : []),
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  registerDpiCommand(pi, "dpi-repo", {
    description: "Inspect or repair the bound Agent content repository",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim() || "status";
      if (sub === "status") ctx.ui.notify(formatReport(await inspectRepo({ network: false })), "info");
      else if (sub === "doctor") ctx.ui.notify(formatReport(await inspectRepo({ network: true })), "info");
      else if (sub === "repair") ctx.ui.notify(formatReport(await repairRepo()), "info");
      else ctx.ui.notify("Usage: /dpi-repo {status|doctor|repair}", "error");
    },
  });
}
