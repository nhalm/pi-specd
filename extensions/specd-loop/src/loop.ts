import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';

import { abortOnCtrlC, type CtrlCWatcher } from './abort-on-ctrl-c.js';
import { runAgentSession } from './agent-runner.js';
import { getHeadCommit } from './git.js';
import { logOutput } from './logger.js';
import { spawnViewerPane, type ViewerHandle } from './viewer-host.js';
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
  const options = parseArgs(args);

  sendProgress(
    pi,
    'info',
    `🚀 Starting specd loop (audit: ${options.skipAudit ? 'skipped' : 'enabled'})`,
  );

  // One viewer pane for the entire loop — every phase forwards events to it.
  // Outside tmux, viewer is null and each phase falls back to the rolling-log widget.
  const viewer = await spawnViewerPane({ title: 'specd loop' });
  // Ctrl+C aborts whichever sub-agent is currently active. Each phase
  // installs its own AbortController so an aborted phase doesn't poison the
  // rest of the loop.
  const ctrlC = abortOnCtrlC(ctx);

  let userAborted = false;
  try {
    userAborted = await runLoopBody(pi, ctx, options, viewer, ctrlC);
  } finally {
    ctrlC.setController(null);
    ctrlC.unsubscribe();
    // Kill the pane immediately if the user aborted; otherwise leave it open
    // so they can scroll back through the run.
    if (viewer) await viewer.close({ kill: userAborted });
  }
}

/**
 * Run a sub-agent and, if the user Ctrl+C's it, ask whether to keep going.
 * Returns "abort" if the user wants to stop the loop, "continue" otherwise
 * (including when the sub-agent finished normally).
 */
async function runPhase(
  ctx: ExtensionCommandContext,
  ctrlC: CtrlCWatcher,
  prompt: string,
  opts: ReturnType<typeof subAgentOpts>,
  phaseLabel: string,
): Promise<{ status: 'ok' | 'abort'; result: Awaited<ReturnType<typeof runAgentSession>> }> {
  const controller = new AbortController();
  ctrlC.setController(controller);
  const result = await runAgentSession(ctx.cwd, prompt, { ...opts, signal: controller.signal });
  ctrlC.setController(null);
  if (!result.aborted) return { status: 'ok', result };
  // User Ctrl+C'd this phase. Ask whether to keep going.
  const cont = await ctx.ui.confirm(
    'Aborted',
    `${phaseLabel} was interrupted with Ctrl+C. Continue with the loop?`,
  );
  return { status: cont ? 'ok' : 'abort', result };
}

function subAgentOpts(viewer: ViewerHandle | null, ctx: ExtensionCommandContext, header: string) {
  if (viewer) {
    return {
      onEvent: (e: AgentSessionEvent) => {
        viewer.send(e);
      },
      attachInput: (steer: (text: string) => void) => viewer.onInput(steer),
    };
  }
  return {
    onLogUpdate: (lines: string[]) => {
      ctx.ui.setWidget('specd-activity', [header, ...lines]);
    },
  };
}

function clearActivityWidget(viewer: ViewerHandle | null, ctx: ExtensionCommandContext) {
  if (!viewer) ctx.ui.setWidget('specd-activity', undefined);
}

async function runLoopBody(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: LoopOptions,
  viewer: ViewerHandle | null,
  ctrlC: CtrlCWatcher,
): Promise<boolean> {
  const cwd = ctx.cwd;

  // ─── Phase 1: Review intake ──────────────────────────────
  showWidget(ctx, 'Review Intake', 0, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', '📋 Running review intake...');
  const intakePhase = await runPhase(
    ctx,
    ctrlC,
    REVIEW_INTAKE_PROMPT,
    subAgentOpts(viewer, ctx, 'Review intake'),
    'Review intake',
  );
  clearActivityWidget(viewer, ctx);
  if (intakePhase.status === 'abort') {
    clearWidget(ctx);
    sendProgress(pi, 'complete', '⏹  Loop aborted by user');
    return true;
  }
  const reviewResult = intakePhase.result;
  if (!reviewResult.success && !reviewResult.aborted) {
    clearWidget(ctx);
    sendProgress(pi, 'error', `❌ Review intake failed`);
    return false;
  }

  const reviewLogPath = await logOutput('review-intake', reviewResult.output);
  sendProgress(pi, 'info', `📋 Review intake logged to: ${reviewLogPath}`);

  // If the user still has undecided findings (or new ones surfaced during intake), pause.
  const reviewListAfterIntake = await loadReviewList(cwd);
  if (getUndecided(reviewListAfterIntake.findings).length > 0) {
    surfaceReviewItems(pi, cwd, getUndecided(reviewListAfterIntake.findings));
    clearWidget(ctx);
    sendProgress(pi, 'complete', `⏸️ Decide the items above, then re-run /specd:loop.`);
    return false;
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
      return false;
    }

    const remainingBefore = getUnblockedItems(workList).length;
    showWidget(ctx, 'Implement', cycle, options.maxCycles, remainingBefore, 'Working...');
    sendProgress(
      pi,
      'running',
      `🔨 Cycle ${cycle}/${options.maxCycles}: [${item.spec}] ${item.description}`,
    );

    const implPhase = await runPhase(
      ctx,
      ctrlC,
      buildImplementPrompt(item),
      subAgentOpts(
        viewer,
        ctx,
        `Cycle ${cycle}/${options.maxCycles}: [${item.spec}] ${item.description}`,
      ),
      `Cycle ${cycle}/${options.maxCycles}`,
    );
    clearActivityWidget(viewer, ctx);
    const implResult = implPhase.result;
    const cycleLogPath = await logOutput(`implement-cycle-${cycle}`, implResult.output);

    if (implPhase.status === 'abort') {
      clearWidget(ctx);
      sendProgress(pi, 'complete', `⏹  Loop aborted by user (cycle ${cycle})`);
      return true;
    }
    // User Ctrl+C'd this cycle but chose to keep going. Skip post-checks (no
    // commit landed) and let the next loop iteration pick up another item.
    if (implResult.aborted) {
      sendProgress(pi, 'info', `↪︎ Cycle ${cycle} skipped — moving on`);
      continue;
    }
    if (!implResult.success) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Implementation subprocess failed (cycle ${cycle}, logged: ${cycleLogPath})`,
      );
      return false;
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
      return false;
    }

    if (!committed) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `❌ Agent did not commit work for [${item.spec}] ${item.description} (logged: ${cycleLogPath}). Item not marked complete. Loop aborted.`,
      );
      return false;
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
      return false;
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
      return false;
    }
  }

  // ─── Phase 3: Audit ───────────────────────────────────────
  if (options.skipAudit) {
    showWidget(ctx, 'Complete', cycle, options.maxCycles, 0, 'Audit skipped');
    sendProgress(pi, 'complete', `✅ Done! Processed ${totalProcessed} items (audit skipped)`);
    return false;
  }

  showWidget(ctx, 'Audit', cycle, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', `🔍 Running audit...`);
  const auditPhase = await runPhase(
    ctx,
    ctrlC,
    AUDIT_PROMPT,
    subAgentOpts(viewer, ctx, 'Audit'),
    'Audit',
  );
  clearActivityWidget(viewer, ctx);
  if (auditPhase.status === 'abort') {
    clearWidget(ctx);
    sendProgress(pi, 'complete', '⏹  Loop aborted by user (audit)');
    return true;
  }
  const auditResult = auditPhase.result;
  // Audit was Ctrl+C'd but user said keep going. There's nothing after audit,
  // so just exit gracefully without treating it as a failure.
  if (auditResult.aborted) {
    clearWidget(ctx);
    sendProgress(pi, 'complete', `✅ Loop done (audit skipped via Ctrl+C)`);
    return false;
  }
  if (!auditResult.success) {
    clearWidget(ctx);
    sendProgress(pi, 'error', `❌ Audit failed`);
    return false;
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
    return false;
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
  return false;
}
