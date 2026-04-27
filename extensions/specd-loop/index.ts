import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { runLoop } from './src/loop.js';
import { runMigrate } from './src/migrate.js';
import { runPlan } from './src/plan.js';
import { loadReviewList, getUndecided } from './src/review.js';
import { runSetup, checkVersion } from './src/setup.js';
import { EXTENSION_VERSION } from './src/version.js';
import { loadWorkList, getUnblockedItems } from './src/worklist.js';

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────
  // /specd:migrate - Migrate from nhalm/specd format
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:migrate', {
    description: 'Migrate from nhalm/specd format to specd-loop format',
    async handler(_args, ctx) {
      const result = await runMigrate(ctx.cwd, ctx.ui);

      if (!result.success) {
        ctx.ui.notify('Migration failed. Check output above for details.', 'error');
      }
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:setup - Initialize specd in the project
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:setup', {
    description: 'Initialize specd files (AGENTS.md, PROJECT.md, specs/)',
    async handler(_args, ctx) {
      const result = await runSetup(ctx);

      let msg = `📦 Specd Setup Complete (v${EXTENSION_VERSION})\n\n`;
      if (result.copied.length > 0) {
        msg += `**Created:**\n`;
        result.copied.forEach((f) => {
          msg += `  • ${f}\n`;
        });
        msg += `\n`;
      }
      if (result.skipped.length > 0) {
        msg += `**Skipped (already exists):**\n`;
        result.skipped.forEach((f) => {
          msg += `  • ${f}\n`;
        });
        msg += `\n`;
      }
      if (result.errors.length > 0) {
        msg += `**Errors:**\n`;
        result.errors.forEach((e) => {
          msg += `  • ${e}\n`;
        });
      }

      msg += '\nNext: Run /specd:plan to create your first spec.';

      ctx.ui.notify(msg, result.errors.length > 0 ? 'error' : 'info');
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:plan - Plan and create specs
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:plan', {
    description: 'Create or update specs and work items',
    async handler(_args, ctx) {
      // Check version
      const versionCheck = await checkVersion(ctx.cwd);
      if (!versionCheck.ok) {
        ctx.ui.notify(
          `${versionCheck.message}\n\nRun /specd:setup first, or continue at your own risk.`,
          'warn',
        );
        // Continue anyway - user might want to proceed
      }

      await runPlan(ctx.cwd, ctx.ui);
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:loop - Run the full loop
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:loop', {
    description: 'Run specd implementation loop (review → implement → audit)',
    async handler(args, ctx) {
      // Check version
      const versionCheck = await checkVersion(ctx.cwd);
      if (!versionCheck.ok) {
        ctx.ui.notify(
          `${versionCheck.message}\n\nRun /specd:setup first, or continue at your own risk.`,
          'warn',
        );
        // Continue anyway - user might want to proceed
      }

      await runLoop(pi, ctx, args);
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:status - Show work list status
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:status', {
    description: 'Show specd work list status',
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

      ctx.ui.notify(msg, 'info');
    },
  });
}
