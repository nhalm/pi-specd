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

export const REVIEW_FILE = "specd_review.yaml";

export async function loadReviewList(cwd: string): Promise<ReviewList> {
  const filePath = resolve(cwd, REVIEW_FILE);
  try {
    const content = await readFile(filePath, "utf-8");
    return parseReviewYaml(content);
  } catch {
    return EMPTY_REVIEW_LIST;
  }
}

export async function saveReviewList(
  cwd: string,
  reviewList: ReviewList,
): Promise<void> {
  const filePath = resolve(cwd, REVIEW_FILE);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = stringifyReviewYaml(reviewList);
  await writeFile(filePath, content, "utf-8");
}

export function getUndecided(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => !f.decision);
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

export function setDecision(
  list: ReviewList,
  index: number,
  decision: string,
): void {
  if (list.findings[index]) {
    list.findings[index].decision = decision;
  }
}

export function removeFinding(list: ReviewList, index: number): void {
  list.findings.splice(index, 1);
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

function parseReviewYaml(content: string): ReviewList {
  const result: ReviewList = { findings: [] };
  if (!content.trim()) return result;

  let currentFinding: ReviewFinding | null = null;
  let currentKey = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // New finding section
    if (trimmed.startsWith("## ")) {
      if (currentFinding) {
        result.findings.push(currentFinding);
      }
      currentFinding = {
        spec: trimmed.slice(3),
        finding: "",
        code: "",
        specText: "",
        options: "",
        recommendation: "",
      };
      currentKey = "";
      continue;
    }

    if (!currentFinding) continue;

    // Key-value pairs
    const kvMatch = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (kvMatch) {
      currentKey = kvMatch[1].toLowerCase();
      const value = kvMatch[2];

      switch (currentKey) {
        case "finding":
          currentFinding.finding = value;
          break;
        case "code":
          currentFinding.code = value;
          break;
        case "spec":
          currentFinding.specText = value;
          break;
        case "options":
          currentFinding.options = value;
          break;
        case "recommendation":
          currentFinding.recommendation = value;
          break;
        case "decision":
          currentFinding.decision = value;
          break;
      }
    }
  }

  if (currentFinding) {
    result.findings.push(currentFinding);
  }

  return result;
}

function stringifyReviewYaml(list: ReviewList): string {
  const lines: string[] = [];

  for (const finding of list.findings) {
    lines.push(`## ${finding.spec}`);
    lines.push(`finding: ${finding.finding}`);
    lines.push(`code: ${finding.code}`);
    lines.push(`spec: ${finding.specText}`);
    lines.push(`options: ${finding.options}`);
    lines.push(`recommendation: ${finding.recommendation}`);
    if (finding.decision) {
      lines.push(`decision: ${finding.decision}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}
