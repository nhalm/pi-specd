import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { getHeadCommit } from './git.js';
import { logOutput } from './logger.js';
import { runPiPrompt } from './pi-runner.js';
import { buildImplementPrompt, REVIEW_INTAKE_PROMPT, AUDIT_PROMPT } from './prompts.js';
import { loadReviewList, getUndecided } from './review.js';
import { sendProgress, surfaceReviewItems } from './ui.js';
import { showWidget, clearWidget } from './widget.js';
import {
  loadWorkList,
  saveWorkList,
  getUnblockedItems,
  pickNextItem,
  markItemCompleted,
  pruneCompletedSpecs,
} from './worklist.js';

const DEFAULT_MAX_CYCLES = 5;

interface LoopOptions {
  skipAudit: boolean;
  maxCycles: number;
}

function parseArgs(args: string): LoopOptions {
  const options: LoopOptions = { skipAudit: false, maxCycles: DEFAULT_MAX_CYCLES };

  for (const part of args.trim().split(/\s+/)) {
    if (part === '--skip-audit') options.skipAudit = true;
    else if (part.startsWith('--max-cycles=')) {
      const val = parseInt(part.split('=')[1] ?? '', 10);
      if (!isNaN(val) && val > 0) options.maxCycles = val;
    }
  }

  return options;
}

export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const cwd = ctx.cwd;
  const options = parseArgs(args);

  sendProgress(
    pi,
    'info',
    `🚀 Starting specd loop (audit: ${options.skipAudit ? 'skipped' : 'enabled'})`,
  );

  // ─── Phase 1: Review intake ──────────────────────────────
  showWidget(ctx, 'Review Intake', 0, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', '📋 Running review intake...');
  const reviewResult = await runPiPrompt(cwd, REVIEW_INTAKE_PROMPT);

  if (!reviewResult.success) {
    clearWidget(ctx);
    sendProgress(pi, 'error', `❌ Review intake failed`);
    return;
  }

  const reviewLogPath = await logOutput('review-intake', reviewResult.output);
  sendProgress(pi, 'info', `📋 Review intake logged to: ${reviewLogPath}`);

  // If the user still has undecided findings (or new ones surfaced during intake), pause.
  const reviewListAfterIntake = await loadReviewList(cwd);
  if (getUndecided(reviewListAfterIntake.findings).length > 0) {
    surfaceReviewItems(pi, cwd, getUndecided(reviewListAfterIntake.findings));
    clearWidget(ctx);
    sendProgress(pi, 'complete', `⏸️ Decide the items above, then re-run /specd:loop.`);
    return;
  }

  sendProgress(pi, 'info', '✅ Review intake complete');

  // ─── Phase 2: Implement loop ─────────────────────────────
  // The loop driver picks one item, hands it to the agent, and verifies a commit
  // landed before marking it complete.
  let cycle = 0;
  let totalProcessed = 0;

  while (cycle < options.maxCycles) {
    cycle++;

    const workList = await loadWorkList(cwd);
    const item = pickNextItem(workList);

    if (!item) {
      sendProgress(pi, 'info', '📋 No work items remaining');
      break;
    }

    const reviewBefore = (await loadReviewList(cwd)).findings.length;
    const headBefore = await getHeadCommit(cwd);
    if (!headBefore) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Cannot verify commits — this directory is not a git repository (or git is unavailable).`,
      );
      return;
    }

    const remainingBefore = getUnblockedItems(workList).length;
    showWidget(ctx, 'Implement', cycle, options.maxCycles, remainingBefore, 'Working...');
    sendProgress(
      pi,
      'running',
      `🔨 Cycle ${cycle}/${options.maxCycles}: [${item.spec}] ${item.description}`,
    );

    const implResult = await runPiPrompt(cwd, buildImplementPrompt(item), 'sonnet');
    const cycleLogPath = await logOutput(`implement-cycle-${cycle}`, implResult.output);

    if (!implResult.success) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Implementation subprocess failed (cycle ${cycle}, logged: ${cycleLogPath})`,
      );
      return;
    }

    // Post-checks: did the agent surface ambiguity? did it commit?
    const reviewAfter = await loadReviewList(cwd);
    const reviewGrew = reviewAfter.findings.length > reviewBefore;
    const headAfter = await getHeadCommit(cwd);
    const committed = headAfter !== null && headAfter !== headBefore;

    if (reviewGrew) {
      sendProgress(
        pi,
        'info',
        `⚠️ Agent surfaced ${reviewAfter.findings.length - reviewBefore} new review item(s) for [${item.spec}] ${item.description}. Item not marked complete.`,
      );
      surfaceReviewItems(pi, cwd, getUndecided(reviewAfter.findings));
      clearWidget(ctx);
      sendProgress(pi, 'complete', `⏸️ Decide the items above, then re-run /specd:loop.`);
      return;
    }

    if (!committed) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Agent did not commit work for [${item.spec}] ${item.description} (logged: ${cycleLogPath}). Item not marked complete. Loop aborted.`,
      );
      return;
    }

    // Mark complete and persist.
    const fresh = await loadWorkList(cwd);
    if (!markItemCompleted(fresh, item.spec, item.description)) {
      // Should be unreachable — item was just picked from this list.
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Internal error: could not locate item to mark complete: [${item.spec}] ${item.description}.`,
      );
      return;
    }
    await saveWorkList(cwd, fresh);
    totalProcessed++;

    const remainingAfter = getUnblockedItems(fresh).length;
    showWidget(ctx, 'Implement', cycle, options.maxCycles, remainingAfter, 'Done ✓');
    sendProgress(
      pi,
      'running',
      `  ✓ Completed [${item.spec}] ${item.description} — ${remainingAfter} item(s) remaining (logged: ${cycleLogPath})`,
    );

    if (remainingAfter === 0) {
      sendProgress(pi, 'complete', '🎉 All work items complete!');
      break;
    }
  }

  if (cycle >= options.maxCycles) {
    const workList = await loadWorkList(cwd);
    if (getUnblockedItems(workList).length > 0) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `⚠️ Max cycles (${options.maxCycles}) reached. ${getUnblockedItems(workList).length} items remain — re-run /specd:loop to continue.`,
      );
      return;
    }
  }

  // ─── Phase 3: Audit ───────────────────────────────────────
  if (options.skipAudit) {
    showWidget(ctx, 'Complete', cycle, options.maxCycles, 0, 'Audit skipped');
    sendProgress(pi, 'complete', `✅ Done! Processed ${totalProcessed} items (audit skipped)`);
    return;
  }

  showWidget(ctx, 'Audit', cycle, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', `🔍 Running audit...`);
  const auditResult = await runPiPrompt(cwd, AUDIT_PROMPT, 'opus');

  if (!auditResult.success) {
    clearWidget(ctx);
    sendProgress(pi, 'error', `❌ Audit failed`);
    return;
  }

  const auditLogPath = await logOutput('audit', auditResult.output);
  sendProgress(pi, 'running', `🔍 Audit logged to: ${auditLogPath}`);

  // If audit raised review items, pause for the user.
  const reviewList = await loadReviewList(cwd);
  const undecided = getUndecided(reviewList.findings);

  if (undecided.length > 0) {
    surfaceReviewItems(pi, cwd, undecided);
    clearWidget(ctx);
    sendProgress(pi, 'complete', `⏸️ Decide the items above, then re-run /specd:loop.`);
    return;
  }

  // Prune specs whose work is fully done — they shouldn't be re-audited next loop.
  const finalWorkList = await loadWorkList(cwd);
  const pruned = pruneCompletedSpecs(finalWorkList);
  if (pruned.length > 0) {
    await saveWorkList(cwd, finalWorkList);
    sendProgress(pi, 'info', `🧹 Removed completed specs from work list: ${pruned.join(', ')}`);
  }

  clearWidget(ctx);
  sendProgress(pi, 'complete', `✅ Loop complete! ${totalProcessed} items, audit clean`);
}
