import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionCommandContext, ExtensionUIContext } from '@mariozechner/pi-coding-agent';

import { REVIEW_FILE, SPEC_INDEX_FILE, WORK_LIST_FILE } from './conventions.js';
import { EXTENSION_VERSION } from './version.js';
import { isRecord } from './yaml-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

interface SetupContext {
  projectName: string;
  description: string;
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
  conventions: string[];
}

interface SetupResult {
  copied: string[];
  skipped: string[];
  errors: string[];
  aborted?: boolean;
}

export interface DetectedCommands {
  build: string[];
  test: string[];
  lint: string[];
}

export type SetupCheckResult = { ok: true } | { ok: false; missing: string[] };

export type VersionCheckResult = { ok: true } | { ok: false; message: string };

// ─────────────────────────────────────────────────────────
// Auto-detection helpers
// ─────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  const pkgPath = resolve(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(pkgPath, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function detectProjectName(cwd: string): Promise<string | null> {
  const pkg = await readPackageJson(cwd);
  if (pkg?.name) return pkg.name.replace(/^@[\w-]+\//, '');

  const parts = cwd.split('/');
  return parts[parts.length - 1] || null;
}

async function detectCommands(cwd: string): Promise<DetectedCommands> {
  const pkg = await readPackageJson(cwd);
  const scripts: Record<string, string> = pkg?.scripts ?? {};

  // Detect from scripts
  const build: string[] = [];
  const test: string[] = [];
  const lint: string[] = [];

  for (const [name, cmd] of Object.entries(scripts)) {
    const cmdStr = `${name}: ${cmd}`;
    if (name.includes('build') || name.includes('compile') || name.includes('start')) {
      build.push(cmdStr);
    }
    if (name.includes('test') || name.includes('spec')) {
      test.push(cmdStr);
    }
    if (name.includes('lint') || name.includes('format') || name.includes('check')) {
      lint.push(cmdStr);
    }
  }

  // Check Makefile
  if (existsSync(resolve(cwd, 'Makefile'))) {
    build.push('make build');
    test.push('make test');
    lint.push('make lint');
  }

  return { build, test, lint };
}

async function detectConventions(cwd: string): Promise<string[]> {
  const conventions: string[] = [];

  // Check for TypeScript
  if (existsSync(resolve(cwd, 'tsconfig.json'))) {
    conventions.push('TypeScript');
  }

  // Check for ESLint
  if (existsSync(resolve(cwd, 'eslint.config.js')) || existsSync(resolve(cwd, '.eslintrc'))) {
    conventions.push('ESLint for linting');
  }

  // Check for Prettier
  if (existsSync(resolve(cwd, '.prettierrc')) || existsSync(resolve(cwd, '.prettierrc.json'))) {
    conventions.push('Prettier for formatting');
  }

  // Check for Jest, Vitest, etc. via package.json deps
  const pkg = await readPackageJson(cwd);
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.jest) conventions.push('Jest for testing');
    if (deps.vitest) conventions.push('Vitest for testing');
    if (deps.prettier) conventions.push('Prettier for formatting');
    if (deps.eslint) conventions.push('ESLint for linting');
  }

  return conventions;
}

// ─────────────────────────────────────────────────────────
// File generation
// ─────────────────────────────────────────────────────────

function generatePROJECTMd(ctx: SetupContext): string {
  const buildSection =
    ctx.buildCommands.length > 0
      ? ctx.buildCommands.map((c) => `- ${c}`).join('\n')
      : '<!-- Add your build commands here, e.g.:\n- npm run build\n- make build -->';

  const testSection =
    ctx.testCommands.length > 0
      ? ctx.testCommands.map((c) => `- ${c}`).join('\n')
      : '<!-- Add your test commands here, e.g.:\n- npm test\n- make test -->';

  const lintSection =
    ctx.lintCommands.length > 0
      ? ctx.lintCommands.map((c) => `- ${c}`).join('\n')
      : '<!-- Add lint/format commands if any -->';

  const conventionsSection =
    ctx.conventions.length > 0
      ? ctx.conventions.map((c) => `- ${c}`).join('\n')
      : '<!-- Add language/framework conventions -->';

  return `# ${ctx.projectName}

> ${ctx.description}

## Build

${buildSection}

## Test

${testSection}

## Validation

${lintSection}

## Conventions

${conventionsSection}

## Dependencies

- **Use interfaces for external dependencies** — database access, HTTP clients, external services
- **Mock at boundaries, not internals**
- **Dependency injection over globals**
`;
}

function generateSpecsReadme(ctx: SetupContext): string {
  return `# Specifications

> ${ctx.description}

## How Specs Work

Specs define **WHAT to build**, not HOW. You describe behavior, contracts, and interfaces. The agent decides the implementation.

**Work items** drive what's worked on. Add items to [${WORK_LIST_FILE}](../${WORK_LIST_FILE}) during \`/specd:plan\`.

**Future items** marked with \`(future)\` are reference only. Do not implement.

## Spec Index

| Spec | Description |
|------|-------------|
| _Add specs here_ | |

---

# Spec Format

Each spec is a markdown file in this directory.

## Required Sections

\`\`\`markdown
# Feature Name

## Overview

What this component does.

**Scope:**
- What it handles
- What it explicitly does NOT handle

**Dependencies:**
- other-spec.md — what we need from it

## Specification

Detailed behavior, contracts, and interfaces. Must be complete enough for implementation without asking questions.

### API (if applicable)
- Endpoint definitions
- Request/response formats
- Error codes

### Data Model (if applicable)
- Schema definitions
- Validations

## Notes

Optional: open questions to resolve before the spec is considered complete.
\`\`\`

## Writing Good Specs

**Do:**
- Define behavior, not code structure
- Include concrete acceptance criteria
- Specify error cases and edge cases
- Use precise language ("returns X" not "should return X")

**Don't:**
- Prescribe file names or function names
- Specify implementation patterns
- Include rationale or "why" explanations
`;
}

// ─────────────────────────────────────────────────────────
// Gitignore
// ─────────────────────────────────────────────────────────

// Normalize a .gitignore line for comparison: strip whitespace, leading slashes,
// and trailing slashes so `.pi-specd`, `/.pi-specd`, and `.pi-specd/ ` all match.
function normalizeGitignoreLine(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

async function updateGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = resolve(cwd, '.gitignore');
  const entries = ['.pi-specd', WORK_LIST_FILE, REVIEW_FILE];
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf-8') : '';
  const existingNormalized = new Set(existing.split('\n').map(normalizeGitignoreLine));
  const missing = entries.filter((e) => !existingNormalized.has(normalizeGitignoreLine(e)));

  if (missing.length > 0) {
    const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
    const block = `${suffix}\n# specd (not committed)\n${missing.join('\n')}\n`;
    await writeFile(gitignorePath, existing + block);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Main setup helpers
// ─────────────────────────────────────────────────────────

/** Show detected items and let the user accept or clear them. */
async function confirmDetected(
  ui: ExtensionUIContext,
  label: string,
  items: string[],
): Promise<string[]> {
  if (items.length === 0) return items;
  const accepted = await ui.confirm(
    label,
    `${items.map((c) => `  - ${c}`).join('\n')}\nUse these?`,
  );
  return accepted ? items : [];
}

type WriteOp = { kind: 'copy'; src: string } | { kind: 'write'; content: string };

/**
 * Create a destination file unless it already exists. Records what happened in `result`.
 * Pass `silent: true` to skip without recording — used for ephemeral state files where
 * "already exists" isn't worth noticing.
 */
async function writeIfMissing(
  result: SetupResult,
  destAbs: string,
  label: string,
  op: WriteOp,
  options: { silent?: boolean } = {},
): Promise<void> {
  if (existsSync(destAbs)) {
    if (!options.silent) {
      result.skipped.push(`${label} (already exists)`);
    }
    return;
  }
  try {
    await mkdir(dirname(destAbs), { recursive: true });
    if (op.kind === 'copy') {
      await copyFile(op.src, destAbs);
    } else {
      await writeFile(destAbs, op.content, 'utf-8');
    }
    result.copied.push(label);
  } catch (err) {
    result.errors.push(`Failed to write ${label}: ${String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────
// Main setup
// ─────────────────────────────────────────────────────────

export async function runSetup(ctx: ExtensionCommandContext): Promise<SetupResult> {
  const cwd = ctx.cwd;
  const result: SetupResult = { copied: [], skipped: [], errors: [] };

  const willCreate = [
    'AGENTS.md (if missing)',
    'PROJECT.md (if missing)',
    `${SPEC_INDEX_FILE} (if missing)`,
    `${WORK_LIST_FILE} (if missing, gitignored)`,
    `${REVIEW_FILE} (if missing, gitignored)`,
    '.pi-specd (version marker, gitignored)',
    '.gitignore (appends specd entries if missing)',
  ];
  const proceed = await ctx.ui.confirm(
    'specd setup',
    `Setup will create or update these files in ${cwd}:\n\n${willCreate.map((p) => `  - ${p}`).join('\n')}\n\nProceed?`,
  );
  if (!proceed) {
    return { ...result, aborted: true };
  }

  // Step 1: Detect existing project info
  const detectedName = await detectProjectName(cwd);
  const detectedCommands = await detectCommands(cwd);
  const detectedConventions = await detectConventions(cwd);

  // Step 2: Ask questions
  const projectName =
    (await ctx.ui.input('Project name', detectedName ?? 'my-project')) ??
    detectedName ??
    'my-project';

  const description = (await ctx.ui.input('One-line project description')) ?? '';

  const buildCommands = await confirmDetected(
    ctx.ui,
    'Detected build commands',
    detectedCommands.build,
  );
  const testCommands = await confirmDetected(
    ctx.ui,
    'Detected test commands',
    detectedCommands.test,
  );
  const lintCommands = await confirmDetected(
    ctx.ui,
    'Detected lint/validation commands',
    detectedCommands.lint,
  );
  const conventions = await confirmDetected(ctx.ui, 'Detected conventions', detectedConventions);

  // Step 3: Generate files
  const setupCtx: SetupContext = {
    projectName,
    description,
    buildCommands,
    testCommands,
    lintCommands,
    conventions,
  };

  await writeIfMissing(result, resolve(cwd, 'AGENTS.md'), 'AGENTS.md', {
    kind: 'copy',
    src: resolve(TEMPLATES_DIR, 'AGENTS.md'),
  });
  await writeIfMissing(result, resolve(cwd, 'PROJECT.md'), 'PROJECT.md', {
    kind: 'write',
    content: generatePROJECTMd(setupCtx),
  });
  await writeIfMissing(result, resolve(cwd, SPEC_INDEX_FILE), SPEC_INDEX_FILE, {
    kind: 'write',
    content: generateSpecsReadme(setupCtx),
  });
  // Ephemeral state files: silently skip if present (no "already exists" notice)
  await writeIfMissing(
    result,
    resolve(cwd, WORK_LIST_FILE),
    WORK_LIST_FILE,
    { kind: 'copy', src: resolve(TEMPLATES_DIR, WORK_LIST_FILE) },
    { silent: true },
  );
  await writeIfMissing(
    result,
    resolve(cwd, REVIEW_FILE),
    REVIEW_FILE,
    { kind: 'copy', src: resolve(TEMPLATES_DIR, REVIEW_FILE) },
    { silent: true },
  );

  if (await updateGitignore(cwd)) {
    result.copied.push('.gitignore (updated)');
  }

  // Write .pi-specd with extension version
  const specdFilePath = resolve(cwd, '.pi-specd');
  try {
    await writeFile(
      specdFilePath,
      `${JSON.stringify({ version: EXTENSION_VERSION, setupAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8',
    );
    result.copied.push('.pi-specd');
  } catch (err) {
    result.errors.push(`Failed to write .pi-specd: ${String(err)}`);
  }

  return result;
}

export const SETUP_REQUIRED_PATHS = ['AGENTS.md', 'PROJECT.md', SPEC_INDEX_FILE] as const;

export async function ensureSpecdSetup(cwd: string): Promise<SetupCheckResult> {
  const missing = SETUP_REQUIRED_PATHS.filter((p) => !existsSync(resolve(cwd, p)));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

interface SpecdInfo {
  version: string;
}

// Only `version` is functionally required. The setup/migrate writers also persist a
// `setupAt`/`migratedAt` timestamp for human inspection, but those keys are never
// read — requiring them in the guard would break migrated projects, since
// `migrate.ts` writes `migratedAt` and `setup.ts` writes `setupAt`.
function isSpecdInfo(value: unknown): value is SpecdInfo {
  return isRecord(value) && typeof value.version === 'string';
}

export async function checkVersion(cwd: string): Promise<VersionCheckResult> {
  const specdFilePath = resolve(cwd, '.pi-specd');

  if (!existsSync(specdFilePath)) {
    return {
      ok: false,
      message: 'No .pi-specd file found. Run /specd:setup first.',
    };
  }

  try {
    const content = await readFile(specdFilePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isSpecdInfo(parsed)) {
      return { ok: false, message: '.pi-specd file is malformed.' };
    }

    if (parsed.version !== EXTENSION_VERSION) {
      return {
        ok: false,
        message: `Extension version mismatch: project uses ${parsed.version}, extension is ${EXTENSION_VERSION}. Run /specd:setup to update.`,
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      message: 'Could not read .pi-specd file.',
    };
  }
}
