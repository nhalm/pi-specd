import { describe, expect, it } from 'vitest';

import { verifyImplementContract } from '../loop-verify.js';

describe('verifyImplementContract', () => {
  it('returns committed when HEAD advances and review unchanged', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 0,
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({ kind: 'committed' });
  });

  it('returns review-grew when review grew, even if HEAD also advanced', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 1,
      reviewAfter: 3,
      headBefore: 'abc123',
      headAfter: 'def456',
      newCommitCount: 1,
    });
    expect(outcome).toEqual({ kind: 'review-grew', newCount: 2 });
  });

  it('returns no-commit when HEAD is unchanged', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 0,
      headBefore: 'abc123',
      headAfter: 'abc123',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'no-commit' });
  });

  it('returns no-commit when headAfter is null (git unavailable)', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 0,
      headBefore: 'abc123',
      headAfter: null,
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'no-commit' });
  });

  it('returns amend-only when HEAD changed but newCommitCount is 0', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 0,
      headBefore: 'abc123',
      headAfter: 'amend9',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'amend-only' });
  });

  it('returns review-grew even when HEAD did not change (review-grew wins over no-commit)', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 2,
      headBefore: 'abc123',
      headAfter: 'abc123',
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'review-grew', newCount: 2 });
  });

  it('returns review-grew when review grew and headAfter is null', () => {
    const outcome = verifyImplementContract({
      reviewBefore: 0,
      reviewAfter: 1,
      headBefore: 'abc123',
      headAfter: null,
      newCommitCount: 0,
    });
    expect(outcome).toEqual({ kind: 'review-grew', newCount: 1 });
  });
});
