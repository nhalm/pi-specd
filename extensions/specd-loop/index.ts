import { resolve } from 'node:path';

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { runLoop } from './src/loop.js';
import { runMigrate } from './src/migrate.js';
import { runPlan } from './src/plan.js';
import { loadReviewList, getUndecided } from './src/review.js';
import { runSetup, checkVersion, ensureSpecdSetup, SETUP_REQUIRED_PATHS } from './src/setup.js';
import { EXTENSION_VERSION } from './src/version.js';
import {
  loadWorkList,
  getUnblockedItems,
  getBlockedItems,
  getCompletedCount,
} from './src/worklist.js';

async function preflight(ctx: ExtensionCommandContext): Promise<boolean> {
  const setupCheck = await ensureSpecdSetup(ctx.cwd);
  if (!setupCheck.ok) {
    ctx.ui.notify(
      `specd is not initialized in this project. Missing: ${setupCheck.missing.join(', ')}\n\nRun /specd:setup first.`,
      'error',
    );
    return false;
  }

  const versionCheck = await checkVersion(ctx.cwd);
  if (!versionCheck.ok) {
    ctx.ui.notify(`${versionCheck.message}\n\nContinuing anyway.`, 'warning');
  }

  return true;
}

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────
  // /specd:migrate - Migrate from nhalm/specd format
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:migrate', {
    description: 'Migrate from nhalm/specd format to specd-loop format',
    async handler(_args, ctx) {
      const result = await runMigrate(pi, ctx);

      if (result.kind === 'error') {
        ctx.ui.notify('Migration failed. Check output above for details.', 'error');
      }
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:setup - Initialize specd in the project
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:setup', {
    description: `Initialize specd in this project (creates ${SETUP_REQUIRED_PATHS.join(', ')})`,
    async handler(_args, ctx) {
      const result = await runSetup(ctx);

      if (result.aborted) {
        ctx.ui.notify('Setup cancelled. No files were modified.', 'info');
        return;
      }

      let msg = `Specd setup complete (v${EXTENSION_VERSION})\n\n`;
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
      if (!(await preflight(ctx))) return;
      runPlan(pi, ctx);
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:loop - Run the full loop
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:loop', {
    description: 'Run the implementation loop. Flags: --skip-audit, --max-cycles=N (default 5)',
    async handler(args, ctx) {
      if (!(await preflight(ctx))) return;
      await runLoop(pi, ctx, args);
    },
  });

  // ─────────────────────────────────────────────────────────
  // /specd:status - Show work list status
  // ─────────────────────────────────────────────────────────
  pi.registerCommand('specd:status', {
    description: 'Show specd work list status',
    async handler(_args, ctx) {
      let workList, reviewList;
      try {
        workList = await loadWorkList(ctx.cwd);
        reviewList = await loadReviewList(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(
          `Could not read specd state: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        return;
      }

      const unblocked = getUnblockedItems(workList);
      const blocked = getBlockedItems(workList);
      const completed = getCompletedCount(workList);
      const undecided = getUndecided(reviewList.findings);

      let msg = `Specd status\n`;
      msg += `   Ready items: ${unblocked.length}\n`;
      msg += `   Blocked: ${blocked.length}\n`;
      msg += `   Completed: ${completed}\n`;
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
          msg += `  - ${item.description} (blocked: ${item.blocked})\n`;
        });
      }

      if (undecided.length > 0) {
        const reviewPath = resolve(ctx.cwd, 'specd_review.yaml');
        msg += `\n**Review needed:** ${undecided.length} finding(s) in ${reviewPath}\n`;
        undecided.slice(0, 5).forEach((f, i) => {
          msg += `${i + 1}. [${f.spec}] ${f.finding.split('\n')[0]}\n`;
        });
        if (undecided.length > 5) msg += `... +${undecided.length - 5} more\n`;
      }

      msg += `\nNext: ${nextAction(unblocked.length, undecided.length)}`;

      ctx.ui.notify(msg, 'info');
    },
  });
}

function nextAction(unblocked: number, undecided: number): string {
  if (undecided > 0) {
    return 'Edit specd_review.yaml to record decisions, then run /specd:loop.';
  }
  if (unblocked > 0) {
    return 'Run /specd:loop to start working through ready items.';
  }
  return 'Run /specd:plan to add new specs and work items.';
}
