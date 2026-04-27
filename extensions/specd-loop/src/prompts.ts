// Internal prompts used by the loop - not auto-discovered

export const PLAN_PROMPT = `---
description: Collaborative planning to create specs and work items
---

## Your Role

You are running the **planning** workflow. Your job is to create specs and write work items.

**Do NOT run any implementation commands.** Implementation is a separate workflow triggered by the user. You only plan — you do not implement.

## Instructions

- Study AGENTS.md for guidelines
- Study specs/README.md to understand existing specs
- Only modify *.md files and specd_work_list.yaml
- When doing research, use "model: Sonnet" agents in parallel

## Workflow

1. **Discuss** — Ask clarifying questions about what the user wants. Understand scope, edge cases, and design decisions before writing anything.
2. **Write the spec** — Create or update the spec in specs/. Specs define WHAT, not HOW. Status: draft
3. **Write work items as you go** — IMMEDIATELY write corresponding work items to specd_work_list.yaml. This is not optional. If you finish planning without writing work items, you have failed.
4. **Update specs/README.md** — Add or update the spec entry in the index.
5. **Done** — Tell the user to mark spec as ready when satisfied.

When **updating** an existing spec, always review the work items in specd_work_list.yaml for that spec. Remove items that are no longer relevant, update items that changed, and unblock items whose dependencies were resolved.

## Work Item Quality

Work items are executed by an autonomous agent. Each item must be:

- A single, concrete task
- Has a clear "done" state that can be validated
- Can be completed in one agent iteration

**Bad:** "Implement auth system", "Add error handling"
**Good:** "Create User model with fields X, Y, Z", "Add POST /auth/register endpoint"

Use (blocked: ...) for items that depend on others.

## Work Item Checkpoint

**This is mandatory.** After writing or modifying a spec section, STOP before writing work items and perform this checkpoint:

1. **List every distinct behavioral requirement** you just wrote in the spec.
2. **Check for implied dependencies.** Each gap is a work item or a blocker.
3. **Write one work item per requirement** — concrete, specific, with a clear done state.
4. **Review existing work items** for this spec. Remove stale items, update changed items, unblock resolved items.

## Spec-vs-Code Analysis

When comparing specs against code, validate against actual code — never write findings directly from agent research.
`;

export const IMPLEMENT_PROMPT = `---
description: Implement one work item from specd_work_list.yaml
---

Study AGENTS.md for guidelines.
Read specd_work_list.yaml — it contains all remaining work items.

Your task is to implement ONE work item, then validate it works.

## Step 0: Check for work

Read specd_work_list.yaml. Find unblocked items (completed: false and no blocked field). If none exist, output \`LOOP_COMPLETE: true\` and stop.

## Step 1: Pick an unblocked item

Each item has a \`spec\` field telling you which spec it belongs to. The spec name maps to specs/{name}.md.

## Step 2: Read the spec

Read specs/{name}.md. Specs are the source of truth, not existing code.

## Step 3: Implement

Implement ONLY the picked work item — nothing else.

## Step 4: Validate

Run tests, fix linting/formatting.

## Step 5: Record

1. Set completed: true for the item in specd_work_list.yaml
2. Remove blocked field from items that depended on what you completed
3. If you encounter an ambiguous situation (unclear if code or spec is wrong), add it to specd_review.yaml
4. Commit code changes

## Writing to specd_review.yaml

If you find an ambiguous issue during implementation:
- Add finding with: spec, finding, code, specText, options, recommendation
- Do NOT decide for the user — just surface the ambiguity
- Continue with the work item instead of getting stuck

Output \`TASK_COMPLETE: true\` when done.

Before declaring LOOP_COMPLETE, re-read specd_work_list.yaml. If any unblocked items remain, pick one and implement it. Only output LOOP_COMPLETE if no unblocked items exist.
`;

export const REVIEW_INTAKE_PROMPT = `---
description: Process specd_review.yaml entries and move to work list
---

Study AGENTS.md for guidelines.

Process specd_review.yaml — convert your decisions into work items or spec changes.

## Step 1: Read review items

For each item in specd_review.yaml that has a decision:
- Read the decision field — this tells you what the user wants
- Read the finding, options, and recommendation for context

## Step 2: Interpret the decision

Decisions tell you what action to take:

**"Fix the code"** → Add work item to specd_work_list.yaml to fix the code

**"Update the spec"** → Update the spec with the correct behavior, then add work item to fix code

**"Ignore" or "Skip"** → Delete the review item, take no action

**"Keep as is"** → Delete the review item, code is correct as-is

**Custom answer** → Do what the user asked in their decision

## Step 3: Write work items

Each work item must be:
- Concrete and actionable
- Can be completed in one iteration
- Uses (blocked: ...) if it depends on other work

## Step 4: Update spec if needed

If the decision requires spec changes:
1. Update the spec to reflect correct behavior
2. Then add corresponding work item

## Step 5: Clean up

After processing all decided items:
- Delete items with decisions from specd_review.yaml
- Keep items without decisions (waiting for more info)
- Commit spec changes

Output \`REVIEW_INTAKE_COMPLETE: true\` when done.
`;

export const AUDIT_PROMPT = `---
description: Audit specs in the work list against code
---

Study AGENTS.md for guidelines.

Your task is to audit specs against code, then write findings.

## Scope

Read specd_work_list.yaml. Look at the \`specs\` array. Each spec has a \`name\` field — audit each one. If \`specs\` is empty, output AUDIT_COMPLETE and stop.

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

Use a research agent (model: Sonnet) to audit spec against code. The agent reads spec and code, reports findings. **Zero findings is valid.**

### Step 2: Validate

Validate each finding yourself:
1. Read the actual code
2. Cross-check against specd_work_list.yaml to avoid duplicates
3. Is the code actually broken? If no, reject.
4. Categorize:
   - Code broken → add to specd_work_list.yaml
   - Spec needs new behavior → update spec
   - Ambiguous → add to specd_review.yaml (do NOT decide for user)
   - Already known/duplicate → skip
   - Works fine → skip

### Step 3: Write

Write confirmed findings.

## Output

Report summary of findings.

Output \`AUDIT_COMPLETE: true\` when done.
Output \`AUDIT_CLEAN: true\` if no new items added to specd_work_list.yaml.
`;

export const FULL_AUDIT_PROMPT = `---
description: Audit all specs against code
---

Study AGENTS.md for guidelines.

Your task is to audit ALL specs against code.

## Scope

Read the specs/ directory. Audit every spec file in it (except this README).

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

For each spec:

### Step 1: Gather

Use a research agent (model: Sonnet) to audit spec against code. **Zero findings is valid.**

### Step 2: Validate

Validate each finding yourself:
1. Read the actual code
2. Cross-check against specd_work_list.yaml to avoid duplicates
3. Is the code actually broken? If no, reject.
4. Categorize:
   - Code broken → add to specd_work_list.yaml
   - Spec needs new behavior → update spec
   - Ambiguous → add to specd_review.yaml (do NOT decide for user)
   - Already known/duplicate → skip
   - Works fine → skip

### Step 3: Write

Write confirmed findings.

### Spec status transitions

The work list drives what's active. No status transitions needed — specs are edited in place.

## Output

Report summary of findings.

Output \`AUDIT_COMPLETE: true\` when done.
Output \`AUDIT_CLEAN: true\` if no new items added to specd_work_list.yaml.
`;
