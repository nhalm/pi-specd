import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

import { REVIEW_FILE } from './conventions.js';
import { isRecord, asString } from './yaml-helpers.js';

export { REVIEW_FILE };

export interface ReviewFinding {
  spec: string;
  finding: string;
  code: string;
  specText: string;
  options: string;
  recommendation: string;
  decision?: string;
}

export interface ReviewList {
  findings: ReviewFinding[];
}

const EMPTY_REVIEW_LIST: ReviewList = { findings: [] };

export async function loadReviewList(cwd: string): Promise<ReviewList> {
  const filePath = resolve(cwd, REVIEW_FILE);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_REVIEW_LIST;
    }
    throw new Error(`Failed to read ${REVIEW_FILE}: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(`Failed to parse ${REVIEW_FILE} as YAML: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return normalizeReviewList(parsed);
}

function normalizeReviewList(data: unknown): ReviewList {
  if (!isRecord(data)) {
    return EMPTY_REVIEW_LIST;
  }

  const findings: ReviewFinding[] = [];

  if (Array.isArray(data.findings)) {
    for (const f of data.findings) {
      if (!isRecord(f)) continue;
      const spec = asString(f.spec);
      findings.push({
        spec,
        finding: asString(f.finding),
        code: asString(f.code),
        specText: asString(f.specText, spec),
        options: asString(f.options),
        recommendation: asString(f.recommendation),
        decision: typeof f.decision === 'string' ? f.decision : undefined,
      });
    }
  }

  return { findings };
}

export function getUndecided(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => !f.decision);
}
