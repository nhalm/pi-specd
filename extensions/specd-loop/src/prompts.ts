// Internal prompts used by the loop - not auto-discovered

export const IMPLEMENT_PROMPT = `---
description: Implement one work item from specd_work_list.yaml
---

Study AGENTS.md for guidelines.
Read specd_work_list.yaml in full — it contains all remaining work items.

Your task is to implement ONE work item, then validate it works.

## Step 0: Check for work

Read specd_work_list.yaml. Check for unblocked items (items without \`blocked:\`). If none, output \`LOOP_COMPLETE: true\` and stop.

## Step 1: Pick an unblocked item

## Step 2: Read the spec

Read the relevant spec from specs/. Specs are the source of truth, not existing code. Only implement items for specs with status "ready".

## Step 3: Implement

Implement ONLY the picked work item — nothing else.

## Step 4: Validate

Run tests, fix linting/formatting.

## Step 5: Record

1. Mark item as completed in specd_work_list.yaml
2. Unblock any items that were waiting for this one
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
description: Audit Ready specs against code and write findings
---

Study AGENTS.md for guidelines.
Study specs/README.md to find all specs and their statuses.

Your task is to audit Ready specs against code, then write findings.

## Scope

Only audit specs with status **Ready**. Skip Implemented, Draft, and Deprecated.

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

For each Ready spec:

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
description: Audit all specs (Ready and Implemented) against code
---

Study AGENTS.md for guidelines.
Study specs/README.md to find all specs and their statuses.

Your task is to audit ALL specs (Ready and Implemented) against code.

## Scope

Audit specs with status **Ready** or **Implemented**. Skip Draft and Deprecated.

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

- Ready with NO findings → "Implemented"
- Implemented with findings → bump version, set to "Ready"
- Ready with findings → stays Ready

## Output

Report summary of findings.

Output \`AUDIT_COMPLETE: true\` when done.
Output \`AUDIT_CLEAN: true\` if no new items added to specd_work_list.yaml.
`;
