import { resolve } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { REVIEW_FILE, type ReviewFinding } from './review.js';

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
          `Add a decision in \`${reviewPath}\`. Common values: \`Fix the code\`, \`Update the spec\`, \`Ignore\`, \`Keep as is\`. Example:`,
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
      { triggerTurn: true },
    );
  }
}

function shortenForExample(text: string): string {
  const firstLine = text.split('\n')[0];
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
