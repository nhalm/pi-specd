import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { abortOnCtrlC, type CtrlCWatcher } from './abort-on-ctrl-c.js';
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { WORK_LIST_FILE, specPath } from './conventions.js';
import { getHeadCommit, getNewCommitCount } from './git.js';
import { logOutput } from './logger.js';
import { findingKey, verifyImplementContract } from './loop-verify.js';
import { spawnViewerPane, type ViewerHandle } from './viewer-host.js';
import { type Phase } from './phase.js';
import { buildImplementPrompt, REVIEW_INTAKE_PROMPT, AUDIT_PROMPT } from './prompts.js';
import { loadReviewList, getUndecided } from './review.js';
import { runOneShot } from './run-one-shot.js';
import { sendProgress, surfaceReviewItems } from './ui.js';
import { showWidget, clearWidget } from './widget.js';
import type { WorkItem } from './types.js';
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

/**
 * Detect a stale checkpoint left behind by a previous crashed run and offer
 * the user a chance to recover. The recovery is **best-effort**: we can't
 * tell with certainty whether the crash happened before or after the
 * markItemCompleted+saveWorkList pair, so we re-mark only when the pending
 * item is still pending in the on-disk work list. If the item is already
 * completed (the crash happened after saveWorkList but before clearing the
 * checkpoint), do nothing — the work was already persisted.
 *
 * Always clears the checkpoint at the end so the next run starts clean.
 */
async function maybeRecoverFromCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const stale = await readCheckpoint(ctx.cwd);
  if (!stale) return;

  const ago = Math.round((Date.now() - new Date(stale.startedAt).getTime()) / 1000);
  const proceed = await ctx.ui.confirm(
    'Resume from checkpoint?',
    [
      `A previous /specd:loop run crashed mid-cycle ${ago}s ago.`,
      `It was finishing item: [${stale.pendingItem.spec}] ${stale.pendingItem.description} (cycle ${stale.cycle}).`,
      ``,
      `If yes: continue from where it left off (mark this item complete; the next loop picks the next item; no double-implementation).`,
      `If no: discard the checkpoint and start fresh.`,
      ``,
      `Resume?`,
    ].join('\n'),
  );

  if (proceed) {
    const wl = await loadWorkList(ctx.cwd);
    const stillPending = wl.specs
      .flatMap((s) => s.items)
      .find(
        (i) =>
          i.spec === stale.pendingItem.spec &&
          i.description === stale.pendingItem.description &&
          !i.completed,
      );
    if (stillPending) {
      markItemCompleted(wl, stale.pendingItem.spec, stale.pendingItem.description);
      await saveWorkList(ctx.cwd, wl);
      sendProgress(
        pi,
        'info',
        `Recovered: marked [${stale.pendingItem.spec}] ${stale.pendingItem.description} complete from checkpoint.`,
      );
    } else {
      sendProgress(
        pi,
        'info',
        `Checkpoint resume: [${stale.pendingItem.spec}] ${stale.pendingItem.description} was already complete in the work list; nothing to do.`,
      );
    }
  } else {
    sendProgress(pi, 'info', 'Discarded crash checkpoint; starting fresh.');
  }
  await clearCheckpoint(ctx.cwd);
}

export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const options = parseArgs(args);

  // If a previous /specd:loop run crashed between markItemCompleted and
  // saveWorkList, a checkpoint file is sitting on disk. Detect it BEFORE
  // doing anything else so the user can choose to recover (mark the in-flight
  // item complete) or discard the checkpoint and start fresh.
  await maybeRecoverFromCheckpoint(pi, ctx);

  sendProgress(
    pi,
    'info',
    `Starting specd loop. Audit: ${options.skipAudit ? 'skipped' : 'enabled'}. Max cycles: ${options.maxCycles}.`,
  );

  if (!process.env.TMUX) {
    sendProgress(
      pi,
      'info',
      'Running outside tmux: sub-agent activity will appear in a compact log above this editor. For a live side pane and mid-run steering, launch pi inside a tmux session.',
    );
  }

  // One viewer pane for the entire loop — every phase forwards events to it.
  // Outside tmux, viewer is null and each phase falls back to the rolling-log widget.
  const viewer = await spawnViewerPane({ title: 'loop' });
  // Ctrl+C aborts whichever sub-agent is currently active. Each phase
  // installs its own AbortController so an aborted phase doesn't poison the
  // rest of the loop.
  const ctrlC = abortOnCtrlC(ctx);

  // Watch for the user closing the side pane mid-run. Each new phase checks
  // `viewerClosed` at startup and, if true, boots in widget mode. We don't
  // try to swap callbacks on an in-flight phase — that phase loses its
  // display until it ends, but the run keeps going.
  let viewerClosed = false;
  let announcedClose = false;
  const releaseClose = viewer?.onClose(() => {
    viewerClosed = true;
    if (!announcedClose) {
      announcedClose = true;
      sendProgress(pi, 'info', 'Side pane closed; remaining phases will use the compact log.');
    }
  });

  let userAborted = false;
  let viewerSummary: string | undefined;
  try {
    const outcome = await runLoopBody(pi, ctx, options, viewer, ctrlC, () => viewerClosed);
    userAborted = outcome.userAborted;
    viewerSummary = outcome.viewerSummary;
  } catch (err) {
    clearWidget(ctx);
    const msg = err instanceof Error ? err.message : String(err);
    // Worklist/review YAML loaders throw "Failed to read …" / "Failed to
    // parse … as YAML: …" — those messages are already self-describing, so
    // the generic "Loop halted: " prefix would just be redundant. Surface
    // them as-is and append a recovery hint instead.
    if (msg.startsWith('Failed to read') || msg.startsWith('Failed to parse')) {
      sendProgress(pi, 'error', `${msg}\nFix the YAML and re-run /specd:loop.`);
    } else {
      sendProgress(pi, 'error', `Loop halted: ${msg}`);
    }
    viewerSummary = 'loop halted — check chat for details';
  } finally {
    // Each phase releases its own controller; no global setController(null)
    // needed here. Just detach the terminal-input listener so further Ctrl+C
    // keystrokes don't fire stale aborts.
    ctrlC.unsubscribe();
    releaseClose?.();
    // Aborts kill the pane immediately. Clean exits (success or recoverable
    // error) send a 'specd:done' control frame so the viewer renders its
    // completion banner, then leave the pane up for the user to dismiss.
    if (viewer) {
      if (userAborted) {
        await viewer.close({ kill: true });
      } else {
        viewer.setDone(viewerSummary ?? 'loop complete');
        await viewer.close({ kill: false });
      }
    }
  }
}

/**
 * Take the last few non-empty lines of a sub-agent transcript so a failure
 * message can include the most recent diagnostic lines without dumping the
 * entire output.
 */
function transcriptTail(output: string, lines = 6): string {
  const tail = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-lines)
    .join('\n');
  return tail.length > 0 ? `\n--- last lines of transcript ---\n${tail}` : '';
}

/**
 * Outcome of one runPhase call. Carries enough information for the caller
 * to react without reaching back into the underlying AgentRunResult shape.
 *
 *  - `success`: sub-agent finished cleanly.
 *  - `aborted-skip`: user Ctrl+C'd, then said "continue with the loop". For
 *    the cycle loop this means "skip this cycle and try the next item";
 *    for non-cycle phases (review intake, audit) there's no follow-up to
 *    skip to, so the caller treats this as "stop here, but it's not a
 *    failure" — see the call sites for the per-phase interpretation.
 *  - `aborted-stop`: user Ctrl+C'd and said "stop the whole loop".
 *  - `error`: runner caught an exception mid-flight; output has the tail.
 */
type PhaseOutcome =
  | { kind: 'success'; output: string }
  | { kind: 'aborted-skip'; output: string }
  | { kind: 'aborted-stop'; output: string }
  | { kind: 'error'; output: string; error?: unknown };

/**
 * Mutable per-run state shared across phases: the viewer pane (or null
 * outside tmux), a function that reports whether the pane has been closed
 * mid-run, and the Ctrl+C watcher whose binding rotates per phase.
 */
interface RunState {
  viewer: ViewerHandle | null;
  isViewerClosed: () => boolean;
  ctrlC: CtrlCWatcher;
}

/**
 * Run a single phase via runOneShot and translate the AgentRunResult into
 * a PhaseOutcome. On abort, asks the user whether to keep going so the
 * driver can decide between skip-and-continue vs stop-the-whole-loop.
 */
async function runPhaseOnce(
  ctx: ExtensionCommandContext,
  phase: Phase,
  state: RunState,
): Promise<PhaseOutcome> {
  const result = await runOneShot(ctx, {
    prompt: phase.prompt,
    label: phase.label,
    viewer: state.viewer,
    isViewerClosed: state.isViewerClosed(),
    ctrlC: state.ctrlC,
  });
  switch (result.kind) {
    case 'success':
      return { kind: 'success', output: result.output };
    case 'error':
      return { kind: 'error', output: result.output, error: result.error };
    case 'aborted': {
      // User Ctrl+C'd this phase. Ask whether to keep going.
      const cont = await ctx.ui.confirm(
        'Aborted',
        `${phase.label} was interrupted with Ctrl+C. Continue with the loop?`,
      );
      return cont
        ? { kind: 'aborted-skip', output: result.output }
        : { kind: 'aborted-stop', output: result.output };
    }
  }
}

function buildCyclePhase(item: WorkItem, cycle: number, max: number): Phase {
  return {
    label: `cycle ${cycle}/${max}: [${item.spec}] ${item.description}`,
    prompt: buildImplementPrompt(item),
    logSlug: `implement-cycle-${cycle}`,
  };
}

const intakePhase: Phase = {
  label: 'review intake',
  prompt: REVIEW_INTAKE_PROMPT,
  logSlug: 'review-intake',
};

const auditPhase: Phase = {
  label: 'audit',
  prompt: AUDIT_PROMPT,
  logSlug: 'audit',
};

/**
 * Outcome of a full loop run, threaded back to runLoop's `finally`:
 *  - `userAborted` controls whether the side pane is killed immediately
 *    (true) or marked done and left up for the user (false).
 *  - `viewerSummary` is a one-liner for the side-pane done banner. The
 *    parent chat already gets the rich progress messages via sendProgress;
 *    this is just the "what happened" footer in the side pane.
 */
interface LoopBodyOutcome {
  userAborted: boolean;
  viewerSummary?: string;
}

async function runLoopBody(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: LoopOptions,
  viewer: ViewerHandle | null,
  ctrlC: CtrlCWatcher,
  isViewerClosed: () => boolean,
): Promise<LoopBodyOutcome> {
  const cwd = ctx.cwd;
  const state: RunState = { viewer, isViewerClosed, ctrlC };

  // ─── Phase 1: Review intake ──────────────────────────────
  showWidget(ctx, 'Review Intake', 0, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', 'Running review intake.');
  const intakeOutcome = await runPhaseOnce(ctx, intakePhase, state);
  if (intakeOutcome.kind === 'aborted-stop') {
    clearWidget(ctx);
    sendProgress(pi, 'complete', 'Loop aborted by user.');
    return { userAborted: true };
  }
  if (intakeOutcome.kind === 'error') {
    const intakeLogPath = await logOutput(intakePhase.logSlug, intakeOutcome.output);
    clearWidget(ctx);
    sendProgress(
      pi,
      'error',
      `Review intake failed. Full transcript: ${intakeLogPath}${transcriptTail(intakeOutcome.output)}`,
    );
    return { userAborted: false, viewerSummary: 'review intake failed — check chat for details' };
  }
  // For review-intake there's no "next item" to skip to, so 'aborted-skip'
  // and 'success' both mean "fall through to the post-intake checks". The
  // skip case just produces an empty/short transcript.

  await logOutput(intakePhase.logSlug, intakeOutcome.output);

  // If the user still has undecided findings (or new ones surfaced during intake), pause.
  const reviewListAfterIntake = await loadReviewList(cwd);
  if (getUndecided(reviewListAfterIntake.findings).length > 0) {
    surfaceReviewItems(pi, cwd, getUndecided(reviewListAfterIntake.findings));
    clearWidget(ctx);
    sendProgress(pi, 'complete', 'Decide the items above, then re-run /specd:loop.');
    return {
      userAborted: false,
      viewerSummary: 'review items pending — decide them in chat, then re-run',
    };
  }

  sendProgress(pi, 'info', 'Review intake complete.');

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
      sendProgress(pi, 'info', 'No work items remaining.');
      break;
    }

    // Precondition: the spec file the implement-prompt tells the agent to read
    // must exist. If a user renamed or deleted it, the cycle would fail
    // mid-run with a missing-file error and surface as "Cycle ended without a
    // commit" — a misleading error class. Halt the loop here so the user sees
    // the real cause before continuing.
    const specFile = resolve(cwd, specPath(item.spec));
    if (!existsSync(specFile)) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `Spec file missing: ${specFile}. Item [${item.spec}] ${item.description} cannot be implemented until the spec exists. Run /specd:plan to recreate it, then re-run /specd:loop.`,
      );
      return {
        userAborted: false,
        viewerSummary: `spec file missing for [${item.spec}] — check chat for details`,
      };
    }

    const findingsBefore = new Set((await loadReviewList(cwd)).findings.map(findingKey));
    const headBefore = await getHeadCommit(cwd);
    if (!headBefore) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        'Cannot verify commits: this directory is not a git repository (or git is unavailable). Run `git init` and try again.',
      );
      return { userAborted: false, viewerSummary: 'not a git repository — check chat for details' };
    }

    const remainingBefore = getUnblockedItems(workList).length;
    showWidget(ctx, 'Implement', cycle, options.maxCycles, remainingBefore, 'Working...');
    sendProgress(
      pi,
      'running',
      `Cycle ${cycle}/${options.maxCycles}: [${item.spec}] ${item.description}`,
    );

    const cyclePhase = buildCyclePhase(item, cycle, options.maxCycles);
    const cycleOutcome = await runPhaseOnce(ctx, cyclePhase, state);
    const cycleLogPath = await logOutput(cyclePhase.logSlug, cycleOutcome.output);

    if (cycleOutcome.kind === 'aborted-stop') {
      clearWidget(ctx);
      sendProgress(pi, 'complete', `Loop aborted by user during cycle ${cycle}.`);
      return { userAborted: true };
    }
    // User Ctrl+C'd this cycle but chose to keep going. Skip post-checks (no
    // commit landed) and let the next loop iteration pick up another item.
    // This is the only call site where 'aborted-skip' literally means "skip
    // and try the next iteration"; review-intake and audit treat it as
    // "fall through" because they have no next iteration to skip to.
    if (cycleOutcome.kind === 'aborted-skip') {
      sendProgress(pi, 'info', `Cycle ${cycle} skipped. Picking up the next item.`);
      continue;
    }
    if (cycleOutcome.kind === 'error') {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `Cycle ${cycle} failed before completion. Full transcript: ${cycleLogPath}${transcriptTail(cycleOutcome.output)}`,
      );
      return {
        userAborted: false,
        viewerSummary: `cycle ${cycle} failed — check chat for details`,
      };
    }

    // Post-checks: did the agent surface ambiguity? did it commit?
    const reviewAfter = await loadReviewList(cwd);
    const findingsAfter = new Set(reviewAfter.findings.map(findingKey));
    const headAfter = await getHeadCommit(cwd);
    const newCommitCount =
      headAfter !== null && headAfter !== headBefore ? await getNewCommitCount(cwd, headBefore) : 0;
    const outcome = verifyImplementContract({
      findingsBefore,
      findingsAfter,
      headBefore,
      headAfter,
      newCommitCount,
    });

    if (outcome.kind === 'review-grew') {
      sendProgress(
        pi,
        'info',
        `Agent surfaced ${outcome.addedKeys.length} new review finding(s) for [${item.spec}] ${item.description}. Item not marked complete.`,
      );
      surfaceReviewItems(pi, cwd, getUndecided(reviewAfter.findings));
      clearWidget(ctx);
      sendProgress(pi, 'complete', 'Decide the items above, then re-run /specd:loop.');
      return {
        userAborted: false,
        viewerSummary: 'new review items surfaced — decide them in chat, then re-run',
      };
    }

    if (outcome.kind === 'no-commit' || outcome.kind === 'amend-only') {
      const reason =
        outcome.kind === 'amend-only'
          ? 'HEAD changed but no new commit descends from the prior tip (looks like `git commit --amend`).'
          : 'No new commit landed.';
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        [
          `Cycle ${cycle} ended without forward progress. ${reason} Item [${item.spec}] ${item.description} stays incomplete.`,
          'To recover:',
          '  1. Run `git status` — if the agent left staged or unstaged changes, finish the commit (or `git stash`/`git checkout -- .` to discard) before re-running.',
          '  2. If a pre-commit / commit-msg hook blocked the commit, fix the underlying issue before re-running.',
          `  3. Full transcript: ${cycleLogPath}`,
          'Re-running /specd:loop will pick this same item up again.',
        ].join('\n'),
      );
      return {
        userAborted: false,
        viewerSummary: `cycle ${cycle} ended without forward progress — check chat for details`,
      };
    }

    // Mark complete and persist. Drop a checkpoint BEFORE we mutate or write
    // anything so a crash during the in-memory mark or the on-disk save can
    // be recovered on the next /specd:loop run. Clear it after the save
    // succeeds — a clean cycle leaves no checkpoint behind.
    await writeCheckpoint(cwd, {
      startedAt: new Date().toISOString(),
      pendingItem: { spec: item.spec, description: item.description },
      cycle,
    });
    const fresh = await loadWorkList(cwd);
    if (!markItemCompleted(fresh, item.spec, item.description)) {
      // Best-effort cleanup: there's nothing to recover from since the mark
      // never landed, and leaving the checkpoint behind would prompt a
      // confusing "resume?" dialog on the next run.
      await clearCheckpoint(cwd);
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `Couldn't re-locate item [${item.spec}] ${item.description} in the work list. Was ${WORK_LIST_FILE} edited mid-loop? Inspect the file and re-run /specd:loop.`,
      );
      return {
        userAborted: false,
        viewerSummary: 'work list mismatch — check chat for details',
      };
    }
    await saveWorkList(cwd, fresh);
    await clearCheckpoint(cwd);
    totalProcessed++;

    const remainingAfter = getUnblockedItems(fresh).length;
    showWidget(ctx, 'Implement', cycle, options.maxCycles, remainingAfter, 'Done');
    sendProgress(
      pi,
      'info',
      `Completed [${item.spec}] ${item.description}. ${remainingAfter} item(s) remaining. Transcript: ${cycleLogPath}`,
    );

    if (remainingAfter === 0) {
      sendProgress(pi, 'info', 'All work items complete.');
      break;
    }
  }

  if (cycle >= options.maxCycles) {
    const workList = await loadWorkList(cwd);
    const remaining = getUnblockedItems(workList).length;
    if (remaining > 0) {
      clearWidget(ctx);
      sendProgress(
        pi,
        'error',
        `Max cycles (${options.maxCycles}) reached with ${remaining} ready item(s) still pending. Re-run /specd:loop to continue, or pass --max-cycles=N to raise the limit.`,
      );
      return {
        userAborted: false,
        viewerSummary: `max cycles reached — ${remaining} item(s) still pending`,
      };
    }
  }

  // ─── Phase 3: Audit ───────────────────────────────────────
  if (options.skipAudit) {
    showWidget(ctx, 'Complete', cycle, options.maxCycles, 0, 'Audit skipped');
    sendProgress(pi, 'complete', `Loop done. Processed ${totalProcessed} item(s). Audit skipped.`);
    return {
      userAborted: false,
      viewerSummary: `loop complete — processed ${totalProcessed} item(s), audit skipped`,
    };
  }

  showWidget(ctx, 'Audit', cycle, options.maxCycles, 0, 'Running...');
  sendProgress(pi, 'running', 'Running audit.');
  const auditOutcome = await runPhaseOnce(ctx, auditPhase, state);
  if (auditOutcome.kind === 'aborted-stop') {
    clearWidget(ctx);
    sendProgress(pi, 'complete', 'Loop aborted by user during audit.');
    return { userAborted: true };
  }
  // Audit was Ctrl+C'd but user said keep going. There's nothing after audit,
  // so 'aborted-skip' has no next iteration to skip to — treat it as "audit
  // was effectively cancelled" and exit gracefully without surfacing a failure.
  if (auditOutcome.kind === 'aborted-skip') {
    clearWidget(ctx);
    sendProgress(pi, 'complete', 'Loop done. Audit skipped via Ctrl+C.');
    return {
      userAborted: false,
      viewerSummary: `loop complete — processed ${totalProcessed} item(s), audit skipped via Ctrl+C`,
    };
  }
  if (auditOutcome.kind === 'error') {
    const failedAuditLog = await logOutput(auditPhase.logSlug, auditOutcome.output);
    clearWidget(ctx);
    sendProgress(
      pi,
      'error',
      `Audit failed before completion. Full transcript: ${failedAuditLog}${transcriptTail(auditOutcome.output)}`,
    );
    return { userAborted: false, viewerSummary: 'audit failed — check chat for details' };
  }

  await logOutput(auditPhase.logSlug, auditOutcome.output);

  // If audit raised review items, pause for the user.
  const reviewList = await loadReviewList(cwd);
  const undecided = getUndecided(reviewList.findings);

  if (undecided.length > 0) {
    surfaceReviewItems(pi, cwd, undecided);
    clearWidget(ctx);
    sendProgress(pi, 'complete', 'Decide the items above, then re-run /specd:loop.');
    return {
      userAborted: false,
      viewerSummary: 'audit raised review items — decide them in chat, then re-run',
    };
  }

  // Prune specs whose work is fully done — they shouldn't be re-audited next loop.
  const finalWorkList = await loadWorkList(cwd);
  const pruned = pruneCompletedSpecs(finalWorkList);
  if (pruned.length > 0) {
    await saveWorkList(cwd, finalWorkList);
  }

  clearWidget(ctx);
  const prunedSuffix = pruned.length > 0 ? ` Pruned completed specs: ${pruned.join(', ')}.` : '';
  sendProgress(
    pi,
    'complete',
    `Loop complete. Processed ${totalProcessed} item(s). Audit clean.${prunedSuffix}`,
  );
  return {
    userAborted: false,
    viewerSummary: `loop complete — processed ${totalProcessed} item(s), audit clean`,
  };
}
