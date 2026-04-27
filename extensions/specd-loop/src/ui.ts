import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type getUndecided } from "./review.js";

export function sendProgress(
  pi: ExtensionAPI,
  status: "running" | "complete" | "error" | "info",
  message: string,
) {
  pi.sendMessage(
    {
      customType: "specd-loop",
      content: message,
      display: true,
      details: { status },
    },
    { triggerTurn: true },
  );
}

// Surface review items to main session
export async function surfaceReviewItems(
  pi: ExtensionAPI,
  cwd: string,
  findings: Awaited<ReturnType<typeof getUndecided>>,
) {
  sendProgress(
    pi,
    "info",
    `📋 ${findings.length} review item(s) need your attention:`,
  );

  for (let i = 0; i < findings.length; i++) {
    const item = findings[i];
    pi.sendMessage(
      {
        customType: "specd-review",
        content: `## ${item.spec}\n\n**Finding:** ${item.finding}\n\n**Code:** ${item.code}\n\n**Spec:** ${item.specText}\n\n**Options:** ${item.options}\n\n**Recommendation:** ${item.recommendation}\n\nTo answer, edit specd_review.yaml and add \`decision: <your answer>\` to this finding.`,
        display: true,
        details: { index: i },
      },
      { triggerTurn: true },
    );
  }
}
