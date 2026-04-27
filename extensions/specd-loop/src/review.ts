import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import yaml from 'js-yaml';

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

export const EMPTY_REVIEW_LIST: ReviewList = {
  findings: [],
};

export const REVIEW_FILE = 'specd_review.yaml';

export async function loadReviewList(cwd: string): Promise<ReviewList> {
  const filePath = resolve(cwd, REVIEW_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = yaml.load(content) as ReviewList;
    if (!parsed || typeof parsed !== 'object') {
      return EMPTY_REVIEW_LIST;
    }
    return normalizeReviewList(parsed);
  } catch {
    return EMPTY_REVIEW_LIST;
  }
}

export async function saveReviewList(cwd: string, reviewList: ReviewList): Promise<void> {
  const filePath = resolve(cwd, REVIEW_FILE);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = yaml.dump({ findings: reviewList.findings }, { indent: 2, lineWidth: -1 });
  await writeFile(filePath, content, 'utf-8');
}

function normalizeReviewList(data: unknown): ReviewList {
  if (!data || typeof data !== 'object') {
    return EMPTY_REVIEW_LIST;
  }

  const obj = data as Record<string, unknown>;
  const findings: ReviewFinding[] = [];

  if (Array.isArray(obj.findings)) {
    for (const f of obj.findings) {
      if (f && typeof f === 'object') {
        const finding = f as Record<string, unknown>;
        findings.push({
          spec: String(finding.spec || ''),
          finding: String(finding.finding || ''),
          code: String(finding.code || ''),
          specText: String(finding.specText || finding.spec || ''),
          options: String(finding.options || ''),
          recommendation: String(finding.recommendation || ''),
          decision: finding.decision ? String(finding.decision) : undefined,
        });
      }
    }
  }

  return { findings };
}

export function getUndecided(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => !f.decision);
}

export function getUndecidedFromList(list: ReviewList): ReviewFinding[] {
  return getUndecided(list.findings);
}

export function addFinding(
  list: ReviewList,
  spec: string,
  finding: string,
  code: string,
  specText: string,
  options: string,
  recommendation: string,
): ReviewFinding {
  const item: ReviewFinding = {
    spec,
    finding,
    code,
    specText,
    options,
    recommendation,
  };
  list.findings.push(item);
  return item;
}

export function setDecision(list: ReviewList, index: number, decision: string): void {
  if (list.findings[index]) {
    list.findings[index].decision = decision;
  }
}

export function removeFinding(list: ReviewList, index: number): void {
  list.findings.splice(index, 1);
}
