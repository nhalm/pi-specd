import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runLoop } from "./loop.js";
import { loadReviewList, getUndecided } from "./review.js";
import { loadWorkList, getUnblockedItems } from "./worklist.js";

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────
  // /specd:loop - Run the full loop
  // ─────────────────────────────────────────────────────────
  pi.registerCommand("specd:loop", {
    description: "Run specd implementation loop (review → implement → audit)",
    async handler(args, ctx) {
      await runLoop(pi, ctx, args);
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:status - Show work list status
  // ─────────────────────────────────────────────────────────
  pi.registerCommand("specd:status", {
    description: "Show specd work list status",
    async handler(_args, ctx) {
      const workList = await loadWorkList(ctx.cwd);
      const reviewList = await loadReviewList(ctx.cwd);

      const unblocked = getUnblockedItems(workList);
      const blocked = workList.specs.flatMap((s) =>
        s.items.filter((i) => !i.completed && i.blocked),
      );
      const undecided = getUndecided(reviewList.findings);

      let msg = `📋 Specd Status\n`;
      msg += `   Ready items: ${unblocked.length}\n`;
      msg += `   Blocked: ${blocked.length}\n`;
      msg += `   Pending review: ${undecided.length}\n\n`;

      if (unblocked.length > 0) {
        msg += `**Next:**\n`;
        unblocked.slice(0, 5).forEach((item, i) => {
          msg += `${i + 1}. [${item.spec}] ${item.description}\n`;
        });
        if (unblocked.length > 5) msg += `... +${unblocked.length - 5} more\n`;
      }

      if (blocked.length > 0) {
        msg += `\n**Blocked:**\n`;
        blocked.slice(0, 3).forEach((item) => {
          msg += `  • ${item.description} (blocked: ${item.blocked})\n`;
        });
      }

      if (undecided.length > 0) {
        msg += `\n**Review needed:** ${undecided.length} finding(s)\n`;
      }

      ctx.ui.notify(msg, "info");
    },
  });
}
