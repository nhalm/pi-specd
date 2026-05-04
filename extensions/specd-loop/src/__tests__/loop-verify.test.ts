import { describe, expect, it } from 'vitest';

import { findingKey, verifyImplementContract } from '../loop-verify.js';

// Helper to build a key-set the way loop.ts does at runtime.
const keys = (...pairs: [string, string][]): Set<string> =>
  new Set(pairs.map(([spec, finding]) => findingKey({ spec, finding })));

describe('verifyImplementContract', () => {
  it('returns committed when HEAD advances and review unchanged', () => {
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: new Set(),
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({ kind: 'committed' });
  });

  it('returns review-grew when review grew, even if HEAD also advanced', () => {
    const before = keys(['auth', 'unclear-token-ttl']);
    const after = keys(
      ['auth', 'unclear-token-ttl'],
      ['auth', 'missing-refresh-flow'],
      ['billing', 'currency-rounding'],
    );
    const outcome = verifyImplementContract({
      findingsBefore: before,
      findingsAfter: after,
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({
      kind: 'review-grew',
      addedKeys: [
        findingKey({ spec: 'auth', finding: 'missing-refresh-flow' }),
        findingKey({ spec: 'billing', finding: 'currency-rounding' }),
      ],
    });
  });

  it('returns no-commit when HEAD is unchanged', () => {
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: new Set(),
      headBefore: 'abc123',
      headAfter: 'abc123',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'no-commit' });
  });

  it('returns no-commit when headAfter is null (git unavailable)', () => {
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: new Set(),
      headBefore: 'abc123',
      headAfter: null,
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'no-commit' });
  });

  it('returns amend-only when HEAD changed but newCommitCount is 0', () => {
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: new Set(),
      headBefore: 'abc123',
      headAfter: 'amend9',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'amend-only' });
  });

  it('returns review-grew even when HEAD did not change (review-grew wins over no-commit)', () => {
    const after = keys(['auth', 'unclear-token-ttl'], ['auth', 'missing-refresh-flow']);
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: after,
      headBefore: 'abc123',
      headAfter: 'abc123',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({
      kind: 'review-grew',
      addedKeys: [
        findingKey({ spec: 'auth', finding: 'unclear-token-ttl' }),
        findingKey({ spec: 'auth', finding: 'missing-refresh-flow' }),
      ],
    });
  });

  it('returns review-grew when review grew and headAfter is null', () => {
    const after = keys(['auth', 'unclear-token-ttl']);
    const outcome = verifyImplementContract({
      findingsBefore: new Set(),
      findingsAfter: after,
      headBefore: 'abc123',
      headAfter: null,
      newCommitCount: 0,
    });
    expect(outcome).toEqual({
      kind: 'review-grew',
      addedKeys: [findingKey({ spec: 'auth', finding: 'unclear-token-ttl' })],
    });
  });

  // Architecture-review motivating case: a cycle that adds finding A and
  // removes finding B has net-zero count change. The old numeric check would
  // pass through and (incorrectly) mark the work item complete despite the
  // newly-surfaced ambiguity. Structural identity catches it.
  it('returns review-grew when one finding is added and another removed (net-zero count)', () => {
    const before = keys(['auth', 'unclear-token-ttl']);
    const after = keys(['auth', 'missing-refresh-flow']);
    const outcome = verifyImplementContract({
      findingsBefore: before,
      findingsAfter: after,
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({
      kind: 'review-grew',
      addedKeys: [findingKey({ spec: 'auth', finding: 'missing-refresh-flow' })],
    });
  });

  // Counter-case: the same finding still present after the cycle is not new.
  // Same set on both sides → no addedKeys → committed (assuming HEAD moved).
  it('returns committed when the same finding is present before and after (same key)', () => {
    const before = keys(['auth', 'unclear-token-ttl']);
    const after = keys(['auth', 'unclear-token-ttl']);
    const outcome = verifyImplementContract({
      findingsBefore: before,
      findingsAfter: after,
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({ kind: 'committed' });
  });
});
