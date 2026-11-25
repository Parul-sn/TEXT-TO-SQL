/**
 * Evaluates Spider Execution Accuracy (EX) and Structural Component Match F1
 * between a predicted SQL query result and a gold ground-truth SQL query result.
 */

export interface TabularResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

function normalizeCell(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return String(val);
    return (Math.round(val * 1000) / 1000).toString();
  }
  const str = String(val).trim();
  const num = Number(str);
  if (str !== '' && !Number.isNaN(num) && Number.isFinite(num)) {
    return Number.isInteger(num) ? String(num) : (Math.round(num * 1000) / 1000).toString();
  }
  return str.toLowerCase();
}

function rowToTuple(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((c) => normalizeCell(row[c])).join('||');
}

export function compareExecutionResults(
  gold: TabularResult,
  predicted: TabularResult,
  orderSensitive: boolean
): boolean {
  if (gold.rows.length !== predicted.rows.length) return false;
  if (gold.rows.length === 0 && predicted.rows.length === 0) return true;
  if (gold.columns.length !== predicted.columns.length) return false;

  const goldTuples = gold.rows.map((r) => rowToTuple(r, gold.columns));
  const predTuples = predicted.rows.map((r) => rowToTuple(r, predicted.columns));

  if (orderSensitive) {
    return goldTuples.every((t, idx) => t === predTuples[idx]);
  }

  const sortedGold = [...goldTuples].sort();
  const sortedPred = [...predTuples].sort();
  return sortedGold.every((t, idx) => t === sortedPred[idx]);
}

export function computeComponentMatchF1(goldSql: string, predictedSql: string): number {
  const goldTokens = tokenizeClauses(goldSql);
  const predTokens = tokenizeClauses(predictedSql);

  if (goldTokens.size === 0 && predTokens.size === 0) return 1;
  if (goldTokens.size === 0 || predTokens.size === 0) return 0;

  let overlap = 0;
  for (const tok of predTokens) {
    if (goldTokens.has(tok)) overlap++;
  }
  const precision = overlap / predTokens.size;
  const recall = overlap / goldTokens.size;
  if (precision + recall === 0) return 0;
  return Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000;
}

function tokenizeClauses(sql: string): Set<string> {
  const normalized = sql
    .toLowerCase()
    .replace(/["`\[\]]/g, '')
    .replace(/;+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized
    .split(/[\s,()=<>!+*/-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== 'as');
  return new Set(tokens);
}
