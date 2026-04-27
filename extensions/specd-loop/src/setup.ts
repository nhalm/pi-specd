import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_VERSION } from './version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

interface SetupContext {
  cwd: string;
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
}

// ─────────────────────────────────────────────────────────
// Auto-detection helpers
// ─────────────────────────────────────────────────────────

async function detectProjectName(cwd: string): Promise<string | null> {
  // Check package.json
  const pkgPath = resolve(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.name) return pkg.name.replace(/^@[\w-]+\//, '');
    } catch {
      // ignore
    }
  }

  // Check for directory name
  const parts = cwd.split('/');
  return parts[parts.length - 1] || null;
}

async function detectCommands(cwd: string): Promise<{
  build: string[];
  test: string[];
  lint: string[];
}> {
  const pkgPath = resolve(cwd, 'package.json');
  const scripts: Record<string, string> = {};

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      Object.assign(scripts, pkg.scripts || {});
    } catch {
      // ignore
    }
  }

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

  // Check for Jest
  const pkgPath = resolve(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.jest) conventions.push('Jest for testing');
      if (deps.vitest) conventions.push('Vitest for testing');
      if (deps.prettier) conventions.push('Prettier for formatting');
      if (deps.eslint) conventions.push('ESLint for linting');
    } catch {
      // ignore
    }
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

**Work items** drive what's worked on. Add items to [specd_work_list.yaml](../specd_work_list.yaml) during \`/specd:plan\`.

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

Optional: open questions to resolve before moving to Ready.
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

async function updateGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = resolve(cwd, '.gitignore');
  const entries = ['.pi-specd', 'specd_work_list.yaml', 'specd_review.yaml'];
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf-8') : '';
  const missing = entries.filter((e) => !existing.split('\n').includes(e));

  if (missing.length > 0) {
    const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
    const block = `${suffix}\n# specd (not committed)\n${missing.join('\n')}\n`;
    await writeFile(gitignorePath, existing + block);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Main setup
// ─────────────────────────────────────────────────────────

export async function runSetup(ctx: {
  cwd: string;
  ui: {
    notify(msg: string, type: string): void;
    prompt(question: string): Promise<string>;
    confirm(question: string): Promise<boolean>;
  };
}): Promise<SetupResult> {
  const cwd = ctx.cwd;
  const result: SetupResult = { copied: [], skipped: [], errors: [] };

  ctx.ui.notify('📦 Starting specd setup...', 'info');

  // Step 1: Detect existing project info
  const detectedName = await detectProjectName(cwd);
  const detectedCommands = await detectCommands(cwd);
  const detectedConventions = await detectConventions(cwd);

  // Step 2: Ask questions
  const projectName =
    (await ctx.ui.prompt(`Project name${detectedName ? ` [${detectedName}]` : ''}: `)) ||
    detectedName ||
    'my-project';

  const description = await ctx.ui.prompt('One-line project description: ');

  let buildCommands = detectedCommands.build;
  let testCommands = detectedCommands.test;
  let lintCommands = detectedCommands.lint;

  if (buildCommands.length > 0) {
    const confirmed = await ctx.ui.confirm(
      `Detected build commands:\n${buildCommands.map((c) => `  - ${c}`).join('\n')}\nUse these?`,
    );
    if (!confirmed) {
      buildCommands = [];
    }
  }

  if (testCommands.length > 0) {
    const confirmed = await ctx.ui.confirm(
      `Detected test commands:\n${testCommands.map((c) => `  - ${c}`).join('\n')}\nUse these?`,
    );
    if (!confirmed) {
      testCommands = [];
    }
  }

  if (lintCommands.length > 0) {
    const confirmed = await ctx.ui.confirm(
      `Detected lint/validation commands:\n${lintCommands.map((c) => `  - ${c}`).join('\n')}\nUse these?`,
    );
    if (!confirmed) {
      lintCommands = [];
    }
  }

  if (detectedConventions.length > 0) {
    const confirmed = await ctx.ui.confirm(
      `Detected conventions:\n${detectedConventions.map((c) => `  - ${c}`).join('\n')}\nUse these?`,
    );
    if (!confirmed) {
      detectedConventions.length = 0;
    }
  }

  // Step 3: Generate files
  const setupCtx: SetupContext = {
    cwd,
    projectName,
    description,
    buildCommands,
    testCommands,
    lintCommands,
    conventions: detectedConventions,
  };

  // Write AGENTS.md
  const agentsSrc = resolve(TEMPLATES_DIR, 'AGENTS.md');
  const agentsDest = resolve(cwd, 'AGENTS.md');
  if (!existsSync(agentsDest)) {
    try {
      await copyFile(agentsSrc, agentsDest);
      result.copied.push('AGENTS.md');
    } catch (err) {
      result.errors.push(`Failed to copy AGENTS.md: ${err}`);
    }
  } else {
    result.skipped.push('AGENTS.md (already exists)');
  }

  // Write PROJECT.md
  const projectMdContent = generatePROJECTMd(setupCtx);
  const projectMdDest = resolve(cwd, 'PROJECT.md');
  if (!existsSync(projectMdDest)) {
    try {
      await writeFile(projectMdDest, projectMdContent, 'utf-8');
      result.copied.push('PROJECT.md');
    } catch (err) {
      result.errors.push(`Failed to write PROJECT.md: ${err}`);
    }
  } else {
    result.skipped.push('PROJECT.md (already exists)');
  }

  // Write specs/README.md
  const specsDir = resolve(cwd, 'specs');
  await mkdir(specsDir, { recursive: true });
  const specsReadmeContent = generateSpecsReadme(setupCtx);
  const specsReadmeDest = resolve(specsDir, 'README.md');
  if (!existsSync(specsReadmeDest)) {
    try {
      await writeFile(specsReadmeDest, specsReadmeContent, 'utf-8');
      result.copied.push('specs/README.md');
    } catch (err) {
      result.errors.push(`Failed to write specs/README.md: ${err}`);
    }
  } else {
    result.skipped.push('specs/README.md (already exists)');
  }

  // Write ephemeral files
  const workListSrc = resolve(TEMPLATES_DIR, 'specd_work_list.yaml');
  const workListDest = resolve(cwd, 'specd_work_list.yaml');
  if (!existsSync(workListDest)) {
    try {
      await copyFile(workListSrc, workListDest);
      result.copied.push('specd_work_list.yaml');
    } catch (err) {
      result.errors.push(`Failed to copy specd_work_list.yaml: ${err}`);
    }
  }

  const reviewSrc = resolve(TEMPLATES_DIR, 'specd_review.yaml');
  const reviewDest = resolve(cwd, 'specd_review.yaml');
  if (!existsSync(reviewDest)) {
    try {
      await copyFile(reviewSrc, reviewDest);
      result.copied.push('specd_review.yaml');
    } catch (err) {
      result.errors.push(`Failed to copy specd_review.yaml: ${err}`);
    }
  }

  // Update .gitignore
  const gitignoreUpdated = await updateGitignore(cwd);
  if (gitignoreUpdated) {
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
    result.errors.push(`Failed to write .pi-specd: ${err}`);
  }

  return result;
}

export async function ensureSpecdSetup(cwd: string): Promise<boolean> {
  const agentsPath = resolve(cwd, 'AGENTS.md');
  const specsDir = resolve(cwd, 'specs');
  const specsReadme = resolve(specsDir, 'README.md');

  return existsSync(agentsPath) && existsSync(specsDir) && existsSync(specsReadme);
}

interface SpecdInfo {
  version: string;
  setupAt: string;
}

export async function checkVersion(cwd: string): Promise<{ ok: boolean; message: string }> {
  const specdFilePath = resolve(cwd, '.pi-specd');

  if (!existsSync(specdFilePath)) {
    return {
      ok: false,
      message: '⚠️  No .pi-specd file found. Run /specd:setup first.',
    };
  }

  try {
    const content = await readFile(specdFilePath, 'utf-8');
    const info: SpecdInfo = JSON.parse(content);

    if (info.version !== EXTENSION_VERSION) {
      return {
        ok: false,
        message: `⚠️  Extension version mismatch: project uses ${info.version}, extension is ${EXTENSION_VERSION}. Run /specd:setup to update.`,
      };
    }

    return { ok: true, message: '' };
  } catch {
    return {
      ok: false,
      message: '⚠️  Could not read .pi-specd file.',
    };
  }
}
