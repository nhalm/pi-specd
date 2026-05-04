import { resolve } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { DECISIONS, REVIEW_FILE } from './conventions.js';
import { type ReviewFinding } from './review.js';

export function sendProgress(
  pi: ExtensionAPI,
  status: 'running' | 'complete' | 'error' | 'info',
  message: string,
) {
  pi.sendMessage(
    { customType: 'specd-loop', content: message, display: true, details: { status } },
    { triggerTurn: true },
  );
}

// Surface review items to main session
export function surfaceReviewItems(pi: ExtensionAPI, cwd: string, findings: ReviewFinding[]) {
  const reviewPath = resolve(cwd, REVIEW_FILE);

  sendProgress(
    pi,
    'info',
    `${findings.length} review finding(s) need a decision. Edit ${reviewPath} (gitignored, lives only on disk) and add a \`decision:\` line under each finding (see options listed below), then re-run \`/specd:loop\`.`,
  );

  // Each finding card is posted with `triggerTurn: false` because pi's
  // sendCustomMessage routing (agent-session.js:942-971) only honors the
  // first triggerTurn while the agent isn't streaming — every subsequent
  // call sees `isStreaming === true` and silently falls through to
  // session.steer(), which the user's steering mode may drop entirely.
  // The leading `sendProgress` call above already triggered one turn for
  // the summary, which is the only turn we want.
  for (let i = 0; i < findings.length; i++) {
    const item = findings[i];
    pi.sendMessage(
      {
        customType: 'specd-review',
        content: [
          `## [${i + 1}] ${item.spec}`,
          ``,
          `**Finding:** ${item.finding}`,
          ``,
          `**Code:** ${item.code}`,
          ``,
          `**Spec:** ${item.specText}`,
          ``,
          `**Options:** ${item.options}`,
          ``,
          `**Recommendation:** ${item.recommendation}`,
          ``,
          `Add a decision in \`${reviewPath}\`. Common values: ${DECISIONS.map((d) => `\`${d}\``).join(', ')}. Example:`,
          ``,
          '```yaml',
          `- spec: ${item.spec}`,
          `  finding: ${shortenForExample(item.finding)}`,
          `  decision: Fix the code`,
          '```',
        ].join('\n'),
        display: true,
        details: { index: i },
      },
      { triggerTurn: false },
    );
  }
}

function shortenForExample(text: string): string {
  const firstLine = text.split('\n')[0];
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
