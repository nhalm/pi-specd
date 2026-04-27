---
description: Collaborative planning to create specs and work items
---

## Your Role

You are running the **planning** workflow. Your job is to create specs and write work items.

**Do NOT run `/specd:implement` or any implementation.** Implementation is a separate workflow triggered by the user. You only plan — you do not implement.

## Instructions

- Study AGENTS.md for guidelines
- Study specs/README.md to understand existing specs
- Only modify \*.md files and specd_work_list.yaml
- When doing research, use "model: Sonnet" agents in parallel

## Workflow

1. **Discuss** — Ask clarifying questions about what the user wants
2. **Write the spec** — Create/update spec in specs/. Specs define WHAT and WHY, not HOW. Status: draft
3. **Write work items as you go** — IMMEDIATELY write corresponding work items to specd_work_list.yaml. This is not optional. If you finish planning without writing work items, you have failed.
4. **Update specs/README.md** — Add/update spec entry
5. **Done** — Tell the user to mark spec as ready when satisfied

## Work Item Quality

Work items are executed by an autonomous agent. Each item must be:

- A single, concrete task
- Has a clear "done" state that can be validated
- Can be completed in one agent iteration

**Bad:** "Implement auth system", "Add error handling"
**Good:** "Create User model with fields X, Y, Z", "Add POST /auth/register endpoint"

Use (blocked: ...) for items that depend on others.

## Work Item Checkpoint

After writing/modifying a spec section, STOP and:

1. List every behavioral requirement in the spec
2. Check for implied dependencies
3. Write one work item per requirement
4. Review existing items for this spec — remove stale, update changed, unblock resolved

## Spec-vs-Code Analysis

When comparing specs to code, validate against actual code — never write findings directly from agent research.
