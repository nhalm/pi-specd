/**
 * Pure verification logic for the implement-cycle "did the agent make valid
 * progress?" decision. Lifted out of loop.ts so it can be unit-tested without
 * spinning up an agent session.
 *
 * Three signals feed in:
 *   - Did the review file grow (agent surfaced ambiguity)?
 *   - Did HEAD advance?
 *   - How many net-new commits landed (rev-list HEAD ^before --count)?
 *
 * Precedence: review-grew wins over everything. If review didn't grow, we
 * compare HEAD movement and the new-commit count to decide between committed,
 * amend-only (HEAD changed but rev-list ^old --count is 0 — typically a
 * `git commit --amend` against the prior tip), and no-commit (HEAD unchanged).
 */

export type ContractOutcome =
  | { kind: 'committed' }
  | { kind: 'review-grew'; newCount: number }
  | { kind: 'no-commit' }
  | { kind: 'amend-only' };

export interface VerifyInput {
  /** Number of findings in specd_review.yaml before the cycle ran. */
  reviewBefore: number;
  /** Number of findings in specd_review.yaml after the cycle ran. */
  reviewAfter: number;
  /** HEAD commit sha before the cycle ran. */
  headBefore: string;
  /** HEAD commit sha after the cycle ran, or null if git is unavailable. */
  headAfter: string | null;
  /** `git rev-list HEAD ^headBefore --count` — number of net-new commits. */
  newCommitCount: number;
}

export function verifyImplementContract(input: VerifyInput): ContractOutcome {
  const { reviewBefore, reviewAfter, headBefore, headAfter, newCommitCount } = input;

  // Review-grew always wins. Even if the agent also committed, surfacing new
  // ambiguity means the item shouldn't be marked complete.
  if (reviewAfter > reviewBefore) {
    return { kind: 'review-grew', newCount: reviewAfter - reviewBefore };
  }

  // HEAD didn't advance at all — no commit happened.
  if (headAfter === null || headAfter === headBefore) {
    return { kind: 'no-commit' };
  }

  // HEAD moved but no new commits descend from the prior tip — the agent
  // amended the previous commit instead of creating a new one. Treat as not
  // making forward progress on this item.
  if (newCommitCount === 0) {
    return { kind: 'amend-only' };
  }

  return { kind: 'committed' };
}
