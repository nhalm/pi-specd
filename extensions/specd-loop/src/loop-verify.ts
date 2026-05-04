/**
 * Pure verification logic for the implement-cycle "did the agent make valid
 * progress?" decision. Lifted out of loop.ts so it can be unit-tested without
 * spinning up an agent session.
 *
 * Three signals feed in:
 *   - Did review surface a *new* finding (compared by structural identity,
 *     not net count — see `findingKey` below)?
 *   - Did HEAD advance?
 *   - How many net-new commits landed (rev-list HEAD ^before --count)?
 *
 * Precedence: review-grew wins over everything. If review didn't grow, we
 * compare HEAD movement and the new-commit count to decide between committed,
 * amend-only (HEAD changed but rev-list ^old --count is 0 — typically a
 * `git commit --amend` against the prior tip), and no-commit (HEAD unchanged).
 *
 * Why structural identity instead of count: a cycle that both adds finding
 * `A` and removes finding `B` has net-zero count change but has still
 * surfaced new ambiguity (`A`). The numeric comparison would let that pass
 * through and mark the work item complete despite the new finding.
 */

export type ContractOutcome =
  | { kind: 'committed' }
  | { kind: 'review-grew'; addedKeys: string[] }
  | { kind: 'no-commit' }
  | { kind: 'amend-only' };

export interface VerifyInput {
  /**
   * Set of finding keys present before the cycle ran. Each key is the
   * `findingKey()` of a finding from specd_review.yaml; callers build this
   * by mapping the loaded findings array.
   */
  findingsBefore: ReadonlySet<string>;
  /** Set of finding keys present after the cycle ran. */
  findingsAfter: ReadonlySet<string>;
  /** HEAD commit sha before the cycle ran. */
  headBefore: string;
  /** HEAD commit sha after the cycle ran, or null if git is unavailable. */
  headAfter: string | null;
  /** `git rev-list HEAD ^headBefore --count` — number of net-new commits. */
  newCommitCount: number;
}

/**
 * Build the structural-identity key for a review finding. `(spec, finding)`
 * is treated as the natural key — two findings with the same spec and the
 * same `finding` text are the same item even if other fields (recommendation,
 * options, decision) drift between cycles. The `::` separator is unlikely to
 * appear in either field naturally; if it does, the key still uniquely
 * identifies the pair (concatenation is injective for fixed-width
 * separators only when neither field contains the separator, but the
 * worst-case collision here is just two findings looking identical, which
 * is the same effect they'd have on the user anyway).
 */
export function findingKey(f: { spec: string; finding: string }): string {
  return `${f.spec}::${f.finding}`;
}

export function verifyImplementContract(input: VerifyInput): ContractOutcome {
  const { findingsBefore, findingsAfter, headBefore, headAfter, newCommitCount } = input;

  // Review-grew always wins. Even if the agent also committed, surfacing new
  // ambiguity means the item shouldn't be marked complete.
  const addedKeys: string[] = [];
  for (const key of findingsAfter) {
    if (!findingsBefore.has(key)) addedKeys.push(key);
  }
  if (addedKeys.length > 0) {
    return { kind: 'review-grew', addedKeys };
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
