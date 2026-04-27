import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { logOutput } from "./logger.js";
import { runPiPrompt } from "./pi-runner.js";
import {
  IMPLEMENT_PROMPT,
  REVIEW_INTAKE_PROMPT,
  AUDIT_PROMPT,
  FULL_AUDIT_PROMPT,
} from "./prompts.js";
import { loadReviewList, getUndecided } from "./review.js";
import { sendProgress, surfaceReviewItems } from "./ui.js";
import { showWidget, clearWidget } from "./widget.js";
import { loadWorkList, getUnblockedItems } from "./worklist.js";

const DEFAULT_MAX_CYCLES = 5;

interface LoopOptions {
  auditMode: "ready" | "full" | "skip";
  maxCycles: number;
}

function parseArgs(args: string): LoopOptions {
  const options: LoopOptions = {
    auditMode: "ready",
    maxCycles: DEFAULT_MAX_CYCLES,
  };

  for (const part of args.trim().split(/\s+/)) {
    if (part === "--full-audit") options.auditMode = "full";
    else if (part === "--skip-audit") options.auditMode = "skip";
    else if (part.startsWith("--max-cycles=")) {
      const val = parseInt(part.split("=")[1], 10);
      if (!isNaN(val) && val > 0) options.maxCycles = val;
    }
  }

  return options;
}

export async function runLoop(
  pi: ExtensionAPI,
  ctx: {
    cwd: string;
    ui: { setWidget(name: string, lines: string[] | undefined): void };
  },
  args: string,
): Promise<void> {
  const cwd = ctx.cwd;
  const options = parseArgs(args);

  sendProgress(
    pi,
    "info",
    `🚀 Starting specd loop (audit: ${options.auditMode})`,
  );

  // Step 1: Review intake
  showWidget(ctx, "Review Intake", 0, options.maxCycles, 0, "Running...");
  sendProgress(pi, "running", "📋 Running review intake...");
  const reviewResult = await runPiPrompt(cwd, REVIEW_INTAKE_PROMPT);

  if (!reviewResult.success) {
    clearWidget(ctx);
    sendProgress(pi, "error", `❌ Review intake failed`);
    return;
  }

  const reviewLogPath = await logOutput("review-intake", reviewResult.output);
  sendProgress(pi, "info", `📋 Review intake logged to: ${reviewLogPath}`);

  // Check for undecided items AFTER review intake
  const reviewListAfterIntake = await loadReviewList(cwd);
  if (getUndecided(reviewListAfterIntake.findings).length > 0) {
    await surfaceReviewItems(
      pi,
      cwd,
      getUndecided(reviewListAfterIntake.findings),
    );
    clearWidget(ctx);
    sendProgress(
      pi,
      "complete",
      `⏸️ Answer the review items above, then run /specd:loop to continue.`,
    );
    return;
  }

  sendProgress(pi, "info", "✅ Review intake complete");

  // Step 2: Implement loop
  let cycle = 0;
  let totalProcessed = 0;

  while (cycle < options.maxCycles) {
    cycle++;

    const workList = await loadWorkList(cwd);
    const unblocked = getUnblockedItems(workList);

    if (unblocked.length === 0) {
      sendProgress(pi, "info", "📋 No work items remaining");
      break;
    }

    showWidget(
      ctx,
      "Implement",
      cycle,
      options.maxCycles,
      unblocked.length,
      "Working...",
    );
    sendProgress(
      pi,
      "running",
      `🔨 Cycle ${cycle}: ${unblocked.length} items to process`,
    );

    const implResult = await runPiPrompt(cwd, IMPLEMENT_PROMPT, "sonnet");

    if (!implResult.success) {
      clearWidget(ctx);
      sendProgress(pi, "error", `❌ Implementation failed`);
      return;
    }

    if (implResult.output.includes("LOOP_COMPLETE: true")) {
      const after = await loadWorkList(cwd);
      const processed = unblocked.length - getUnblockedItems(after).length;
      totalProcessed += processed;
      sendProgress(pi, "info", `✅ Implementation done (${processed} items)`);
      break;
    }

    // Check progress
    const after = await loadWorkList(cwd);
    const processed = unblocked.length - getUnblockedItems(after).length;
    totalProcessed += processed;
    const remaining = getUnblockedItems(after).length;

    // Check for review items created during implementation
    const reviewListAfterImpl = await loadReviewList(cwd);
    const undecidedAfterImpl = getUndecided(reviewListAfterImpl.findings);

    if (undecidedAfterImpl.length > 0) {
      await surfaceReviewItems(pi, cwd, undecidedAfterImpl);
      clearWidget(ctx);
      sendProgress(
        pi,
        "complete",
        `⏸️ ${undecidedAfterImpl.length} review item(s) found. Answer them, then run /specd:loop to continue.`,
      );
      return;
    }

    const cycleLogPath = await logOutput(
      `implement-cycle-${cycle}`,
      implResult.output,
    );
    showWidget(ctx, "Implement", cycle, options.maxCycles, remaining, "Done ✓");
    sendProgress(
      pi,
      "running",
      `  ✓ Processed ${processed}, ${remaining} remaining (logged: ${cycleLogPath})`,
    );

    if (remaining === 0) {
      sendProgress(pi, "complete", "🎉 All work items complete!");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (cycle >= options.maxCycles) {
    const workList = await loadWorkList(cwd);
    if (getUnblockedItems(workList).length > 0) {
      clearWidget(ctx);
      sendProgress(
        pi,
        "error",
        `⚠️ Max cycles reached. ${getUnblockedItems(workList).length} items remain.`,
      );
      return;
    }
  }

  // Step 3: Audit
  if (options.auditMode === "skip") {
    showWidget(ctx, "Complete", cycle, options.maxCycles, 0, "Audit skipped");
    sendProgress(
      pi,
      "complete",
      `✅ Done! Processed ${totalProcessed} items (audit skipped)`,
    );
    return;
  }

  showWidget(ctx, "Audit", cycle, options.maxCycles, 0, "Running...");
  sendProgress(pi, "running", `🔍 Running ${options.auditMode} audit...`);
  const auditPrompt =
    options.auditMode === "full" ? FULL_AUDIT_PROMPT : AUDIT_PROMPT;
  const auditResult = await runPiPrompt(cwd, auditPrompt, "opus");

  if (!auditResult.success) {
    clearWidget(ctx);
    sendProgress(pi, "error", `❌ Audit failed`);
    return;
  }

  const auditLogPath = await logOutput(
    `${options.auditMode}-audit`,
    auditResult.output,
  );
  sendProgress(pi, "running", `🔍 Audit logged to: ${auditLogPath}`);

  // Surface review items if any were found
  const reviewList = await loadReviewList(cwd);
  const undecided = getUndecided(reviewList.findings);

  if (undecided.length > 0) {
    await surfaceReviewItems(pi, cwd, undecided);
    clearWidget(ctx);
    sendProgress(
      pi,
      "complete",
      `⏸️ Answer the review items above, then run /specd:loop to continue.`,
    );
    return;
  }

  clearWidget(ctx);
  sendProgress(
    pi,
    "complete",
    `✅ Loop complete! ${totalProcessed} items, audit clean`,
  );
}
