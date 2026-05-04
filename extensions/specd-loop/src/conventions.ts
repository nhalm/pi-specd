/**
 * Single source of truth for the file paths, directory layout, and
 * vocabulary the loop driver and prompts both depend on.
 *
 * Editing one of these requires editing prompts (so the agent uses the new
 * name) AND parsers (so the driver reads the new name). Centralizing them
 * here prevents drift.
 */

export const SPEC_DIR = 'specs';
export const SPEC_INDEX_FILE = `${SPEC_DIR}/README.md`;

/** Local-only state files; both are gitignored. */
export const WORK_LIST_FILE = 'specd_work_list.yaml';
export const REVIEW_FILE = 'specd_review.yaml';

/** Resolve the markdown file for a named spec. */
export function specPath(name: string): string {
  return `${SPEC_DIR}/${name}.md`;
}

/**
 * Canonical decision values the user can write into specd_review.yaml.
 * The implement/review-intake prompts reference these by name; the UI
 * surfaces them as the suggested options.
 *
 * `Skip` is a documented synonym for `Ignore`; agents and the surfacing UI
 * accept either.
 */
export const DECISIONS = ['Fix the code', 'Update the spec', 'Ignore', 'Keep as is'] as const;
export type Decision = (typeof DECISIONS)[number];
export const DECISION_SYNONYMS: Readonly<Record<string, Decision>> = {
  Skip: 'Ignore',
};

/**
 * Conventional Commits types pi-specd's loop expects to see. Mirrors
 * @commitlint/config-conventional. Used in the implement prompt's commit
 * format guidance.
 */
export const COMMIT_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];
