// Internal prompts used by the loop - not auto-discovered.
// The loop driver reads YAML state to know when each phase is done.
// Prompts intentionally do NOT emit completion sentinels.

import type { WorkItem } from './types.js';

export const PLAN_PROMPT = `---
description: Collaborative planning to create specs and work items
---

## Your Role

You are running the **planning** workflow. Your job is to create specs and write work items.

**Do NOT run any implementation commands.** Implementation is a separate workflow triggered by the user. You only plan — you do not implement.

## Instructions

- Study AGENTS.md for guidelines
- Study specs/README.md to understand existing specs
- Only modify *.md files, specd_work_list.yaml, and specd_review.yaml
- When doing research, use "model: Sonnet" agents in parallel

## Workflow

1. **Discuss** — Ask clarifying questions about what the user wants. Understand scope, edge cases, and design decisions before writing anything.
2. **Write the spec** — Create or update the spec in specs/. Specs define WHAT, not HOW.
3. **Write work items** — End each planning session by writing corresponding work items to specd_work_list.yaml. If no items are needed yet (e.g. you only updated docs), say so explicitly.
4. **Update specs/README.md** — Add or update the spec entry in the index.

If you encounter open spec questions you can't resolve in the planning conversation, surface them by writing a finding to specd_review.yaml so the user can decide.

When **updating** an existing spec, always review the work items in specd_work_list.yaml for that spec. Remove items that are no longer relevant, update items that changed, and unblock items whose dependencies were resolved.

## Work Item Quality

Work items are executed by an autonomous agent. Each item must be:

- A single, concrete task
- Has a clear "done" state that can be validated
- Can be completed in one agent iteration

**Bad:** "Implement auth system", "Add error handling"
**Good:** "Create User model with fields X, Y, Z", "Add POST /auth/register endpoint"

For items that depend on others, add a \`blocked: <reason>\` field on the item.

## Work Item Checkpoint

After writing or modifying a spec section, perform this checkpoint before writing work items:

1. **List every distinct behavioral requirement** you just wrote in the spec.
2. **Check for implied dependencies.** Each gap is a work item or a blocker.
3. **Write one work item per requirement** — concrete, specific, with a clear done state.
4. **Review existing work items** for this spec. Remove stale items, update changed items, unblock resolved items.

## Spec-vs-Code Analysis

When comparing specs against code, validate against actual code — never write findings directly from agent research.
`;

export function buildImplementPrompt(item: WorkItem): string {
  return `---
description: Implement a single work item assigned by the loop driver
---

Study AGENTS.md for guidelines.

## Your task

You have been assigned exactly one work item. Do not pick a different item, do not pick up additional work, do not look at specd_work_list.yaml.

- **Spec:** \`specs/${item.spec}.md\`
- **Item:** ${item.description}

## Steps

1. Read \`specs/${item.spec}.md\`. The spec is the source of truth, not the existing code.
2. Implement ONLY the work item described above.
3. Validate: run tests, run lint/format, fix anything you broke.
4. Commit. The commit message MUST follow [Conventional Commits](https://www.conventionalcommits.org/):

   \`\`\`
   <type>(<optional scope>): <subject>

   <optional body>
   \`\`\`

   - \`type\` ∈ { feat, fix, chore, refactor, docs, test, perf, ci, build, style }
   - Subject: imperative mood, lowercase, no trailing period, under 72 chars.
   - Example: \`feat(auth): add POST /auth/register endpoint\`

   If a pre-commit or commit-msg hook fails, **fix the underlying issue and recommit** — do not bypass with \`--no-verify\`.

## If you find an ambiguity

If implementing this item exposes a contradiction (spec says X, code expects Y, no obvious right answer), append a finding to \`specd_review.yaml\` describing it and **stop without committing**. The loop driver will surface it to the user.

## If you notice unrelated follow-up work

Don't add it to the work list yourself. Append a finding to \`specd_review.yaml\` describing what you noticed; the user can decide whether to schedule it.

## Hard constraints

- Do NOT modify \`specd_work_list.yaml\` — the loop driver owns it.
- Do NOT pick a second work item. One item per turn.
- The loop driver verifies a commit landed before marking your item complete. No commit means no progress.
`;
}

export const REVIEW_INTAKE_PROMPT = `---
description: Process specd_review.yaml entries and move to work list
---

Study AGENTS.md for guidelines.

Process specd_review.yaml — convert decided findings into work items or spec changes.

## Step 1: Read review items

For each finding in specd_review.yaml:
- If it has a \`decision\` field, act on it (Step 2).
- If it has no \`decision\`, leave it untouched.

## Step 2: Interpret the decision

| Decision           | Action                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| \`Fix the code\`     | Add a work item to specd_work_list.yaml describing the code fix.        |
| \`Update the spec\`  | Edit the spec to reflect correct behavior, then add a work item.        |
| \`Ignore\` / \`Skip\`  | Remove the finding from specd_review.yaml. Take no other action.        |
| \`Keep as is\`       | Remove the finding from specd_review.yaml. Take no other action.        |
| Custom answer      | Follow the user's instruction — but see the next paragraph.             |

**If a custom answer is too vague, contradictory, or could be interpreted multiple ways, do NOT act on it.** Leave the finding in place (do not delete it, do not add work items, do not edit specs) and add a short \`clarification_needed:\` field to the finding describing what's unclear. The user can then refine the decision on the next loop.

## Step 3: Write work items

Each work item must be:
- Concrete and actionable
- Completable in one implementation turn
- Has a \`blocked: <reason>\` field if it depends on other work

## Step 4: Clean up

After processing all decided findings:
- Remove findings whose decision has been fully acted on (or that resolved to "no action").
- Keep findings without decisions and findings you marked \`clarification_needed:\`.
- Commit any spec changes plus the updated YAML files in one commit using Conventional Commits format (e.g. \`chore(specd): process review decisions\`).
`;

export const AUDIT_PROMPT = `---
description: Audit specs in the work list against code
---

Study AGENTS.md for guidelines.

Your task is to audit specs against code and write findings.

## Scope

Read specd_work_list.yaml. Audit each spec listed in its \`specs\` array. The work list driver removes specs whose work is fully complete, so anything still listed has active work and is in scope.

If the \`specs\` array is empty, there is nothing to audit — stop.

## What counts as a finding

Only flag things that are **functionally wrong**:

- Code produces wrong results or crashes
- Spec-required feature is missing
- Types wrong at API boundaries

NOT a finding:

- Different pattern than spec suggests
- Spec wording doesn't match implementation details
- Cosmetic differences
- Documentation gaps

## Process

For each spec in scope:

### Step 1: Gather

Use a research agent (model: Sonnet) to audit spec against code. **Zero findings is valid.**

### Step 2: Validate

Validate each finding yourself:

1. Read the actual code.
2. Cross-check against specd_work_list.yaml to avoid duplicates.
3. Is the code actually broken? If no, reject the finding.
4. Categorize:
   - Code broken → add a work item to specd_work_list.yaml.
   - Spec needs new behavior → update the spec, then add a work item.
   - Ambiguous → add a finding to specd_review.yaml (do NOT decide for the user).
   - Already known / duplicate → skip.
   - Works fine → skip.

### Step 3: Write

Write confirmed findings to the appropriate file.

## Commit

Commit any spec edits, work-list changes, or review-list additions in one commit using Conventional Commits format (e.g. \`chore(specd): record audit findings\`).

## Output

Report a short summary of findings (or zero findings) at the end of your turn. The loop driver decides what happens next based on the YAML state.
`;
