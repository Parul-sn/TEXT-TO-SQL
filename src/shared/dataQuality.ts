import type {
  AnomalyRecord,
  ColumnSchema,
  ImputedCellMeta,
} from './types.ts';

const MISSING_SENTINELS = new Set([
  '',
  'na',
  'n/a',
  'null',
  'none',
  'nan',
  'unknown',
  '-',
  '?',
]);

export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  if (typeof value === 'string') {
    return MISSING_SENTINELS.has(value.trim().toLowerCase());
  }
  return false;
}

export function detectNumericOutliers(
  rows: Record<string, unknown>[],
  tableName: string,
  columnName: string
): AnomalyRecord | null {
  const numericEntries: Array<{ idx: number; val: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i][columnName];
    if (isMissingValue(raw)) continue;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      numericEntries.push({ idx: i, val: num });
    }
  }

  if (numericEntries.length === 0) return null;

  const sorted = [...numericEntries].map((e) => e.val).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;

  // Domain check for inherently non-negative fields
  const lowerName = columnName.toLowerCase();
  const mustBeNonNegative =
    /(age|salary|price|amount|total|cost|qty|quantity|hours|score|revenue|count|weight|height|budget|bp)/.test(
      lowerName
    );

  if (numericEntries.length < 5 && !mustBeNonNegative) {
    return null;
  }

  const outliers = numericEntries.filter((e) => {
    if (mustBeNonNegative && e.val < 0) return true;
    if (numericEntries.length < 5) return false;
    if (iqr === 0) {
      const median = sorted[Math.floor(sorted.length * 0.5)];
      return median !== 0 && Math.abs(e.val - median) > Math.abs(median) * 4;
    }
    return e.val < lowerFence || e.val > upperFence;
  });

  if (outliers.length === 0) return null;

  const hasNegativeViolation = mustBeNonNegative && outliers.some((o) => o.val < 0);
  const numericOptions = hasNegativeViolation
    ? [
        {
          id: 'nullify_and_impute' as const,
          label: 'Nullify & Re-Impute',
          description:
            'Set invalid negative/outlier entries to NULL and mark for peer-group imputation.',
          recommended: true,
        },
        {
          id: 'abs_value' as const,
          label: 'Convert Negative to Positive',
          description: 'Flip negative values using ABS(value) so magnitude is kept positive.',
        },
        {
          id: 'set_zero' as const,
          label: 'Replace Negative with 0',
          description: 'Set all negative entries in this column to 0.',
        },
        {
          id: 'delete_rows' as const,
          label: 'Delete Affected Rows',
          description: 'Remove rows containing invalid negative or extreme values.',
        },
      ]
    : [
        {
          id: 'clamp_outlier' as const,
          label: 'Clamp to IQR Fence',
          description: `Clamp values outside [${round2(Math.max(0, lowerFence))}, ${round2(upperFence)}] to fence bounds.`,
          recommended: true,
        },
        {
          id: 'nullify_and_impute' as const,
          label: 'Nullify Outliers',
          description: 'Set out-of-range outliers to NULL so peer imputation can estimate them.',
        },
        {
          id: 'delete_rows' as const,
          label: 'Delete Outlier Rows',
          description: 'Remove rows whose value lies outside the IQR statistical fence.',
        },
      ];

  return {
    id: `outlier_${tableName}_${columnName}`,
    kind: hasNegativeViolation ? 'negative_domain_violation' : 'numeric_outlier',
    severity: hasNegativeViolation || outliers.length >= 2 ? 'high' : 'medium',
    tableName,
    columnName,
    affectedRowCount: outliers.length,
    sampleValues: outliers.slice(0, 4).map((o) => String(o.val)),
    description: hasNegativeViolation
      ? `${outliers.length} row(s) in ${tableName}.${columnName} contain negative or extreme domain-violating values (IQR fence [${round2(lowerFence)}, ${round2(upperFence)}]).`
      : `${outliers.length} statistical outlier(s) detected in ${tableName}.${columnName} outside IQR fence [${round2(lowerFence)}, ${round2(upperFence)}].`,
    recommendedAction: hasNegativeViolation
      ? 'Nullify invalid negative/extreme entries and impute using peer group median.'
      : 'Clamp extreme values to IQR fence bounds or nullify and re-impute.',
    cleanActionType: hasNegativeViolation ? 'nullify_and_impute' : 'clamp_outlier',
    cleaningOptions: numericOptions,
    cleared: false,
  };
}

export function detectCasingAndWhitespaceAnomalies(
  rows: Record<string, unknown>[],
  tableName: string,
  columnName: string
): AnomalyRecord | null {
  const variantsByCanonical = new Map<string, Set<string>>();
  let affectedCount = 0;
  const samples = new Set<string>();

  for (const row of rows) {
    const raw = row[columnName];
    if (typeof raw !== 'string' || isMissingValue(raw)) continue;
    const canonical = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!variantsByCanonical.has(canonical)) {
      variantsByCanonical.set(canonical, new Set());
    }
    variantsByCanonical.get(canonical)!.add(raw);
    if (raw !== raw.trim()) {
      affectedCount++;
      samples.add(JSON.stringify(raw));
    }
  }

  for (const [, variants] of variantsByCanonical.entries()) {
    if (variants.size > 1) {
      affectedCount += variants.size;
      for (const v of variants) {
        samples.add(v);
      }
    }
  }

  if (affectedCount === 0) return null;

  return {
    id: `casing_${tableName}_${columnName}`,
    kind: 'casing_fragmentation',
    severity: 'medium',
    tableName,
    columnName,
    affectedRowCount: affectedCount,
    sampleValues: Array.from(samples).slice(0, 4),
    description: `Inconsistent casing or trailing whitespace in ${tableName}.${columnName} splits identical categories during GROUP BY / WHERE filters.`,
    recommendedAction: 'Trim whitespace and normalize to canonical Title Case.',
    cleanActionType: 'normalize_text',
    cleaningOptions: [
      {
        id: 'normalize_text',
        label: 'Trim & Title Case',
        description: 'Trim extra spaces and convert values to canonical Title Case.',
        recommended: true,
      },
      {
        id: 'normalize_upper',
        label: 'Trim & UPPERCASE',
        description: 'Trim extra spaces and convert all values to UPPERCASE.',
      },
      {
        id: 'normalize_lower',
        label: 'Trim & lowercase',
        description: 'Trim extra spaces and convert all values to lowercase.',
      },
      {
        id: 'trim_only',
        label: 'Trim Whitespace Only',
        description: 'Remove leading, trailing, and repeated spaces while keeping existing case.',
      },
    ],
    cleared: false,
  };
}

/**
 * Cross-column / peer-group imputation engine.
 * Explicitly marks every filled cell as `isGuessed = true` with full explanation
 * of which other columns/rows were used to approximate the missing value.
 */
export function imputeMissingValues(
  tableName: string,
  rows: Record<string, unknown>[],
  columns: ColumnSchema[],
  pkCol?: string
): {
  imputedRows: Record<string, unknown>[];
  imputedCells: ImputedCellMeta[];
} {
  const imputedRows = rows.map((r) => ({ ...r }));
  const imputedCells: ImputedCellMeta[] = [];

  if (rows.length === 0) {
    return { imputedRows, imputedCells };
  }

  // Candidate grouping columns (low-to-medium cardinality categorical strings/FKs)
  const groupCandidates = columns.filter((c) => {
    if (c.isPrimaryKey) return false;
    const distinct = new Set(
      rows.map((r) => r[c.name]).filter((v) => !isMissingValue(v))
    );
    return distinct.size >= 2 && distinct.size <= Math.max(8, Math.floor(rows.length * 0.6));
  });

  for (const col of columns) {
    if (col.isPrimaryKey) continue;

    // Determine if column is numeric or categorical based on non-missing entries
    const nonMissing = rows
      .map((r) => r[col.name])
      .filter((v) => !isMissingValue(v));

    if (nonMissing.length === 0) continue;

    const numericVals = nonMissing
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => !Number.isNaN(n) && Number.isFinite(n));
    const isNumeric = numericVals.length >= Math.ceil(nonMissing.length * 0.7);

    // Pick best grouping column that minimizes intra-group variance or maximizes purity
    let bestGroupCol: string | null = null;
    if (groupCandidates.length > 0) {
      const candidate = groupCandidates.find((g) => g.name !== col.name);
      if (candidate) {
        bestGroupCol = candidate.name;
      }
    }

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const originalVal = rows[rowIdx][col.name];
      if (!isMissingValue(originalVal)) continue;

      let guessedValue: string | number;
      let method: string;
      let basisColumns: string[];
      let confidence: number;
      let explanation: string;

      if (isNumeric) {
        const groupKey = bestGroupCol ? rows[rowIdx][bestGroupCol] : null;
        const peerNums =
          bestGroupCol && !isMissingValue(groupKey)
            ? rows
                .filter(
                  (r) =>
                    String(r[bestGroupCol!]).toLowerCase() ===
                      String(groupKey).toLowerCase() && !isMissingValue(r[col.name])
                )
                .map((r) => Number(r[col.name]))
                .filter((n) => !Number.isNaN(n))
            : [];

        if (peerNums.length >= 2) {
          const avg = peerNums.reduce((a, b) => a + b, 0) / peerNums.length;
          guessedValue = round2(avg);
          method = 'Conditional Peer-Group Mean';
          basisColumns = [bestGroupCol!];
          confidence = Math.min(0.92, 0.68 + peerNums.length * 0.04);
          explanation = `Guessed from ${peerNums.length} peer rows sharing ${bestGroupCol} = "${String(groupKey)}".`;
        } else {
          const sorted = [...numericVals].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          guessedValue = round2(median);
          method = 'Column Median Fallback';
          basisColumns = [col.name];
          confidence = 0.56;
          explanation = `Guessed using median of ${numericVals.length} observed ${col.name} values.`;
        }
      } else {
        const groupKey = bestGroupCol ? rows[rowIdx][bestGroupCol] : null;
        const peerStrings =
          bestGroupCol && !isMissingValue(groupKey)
            ? rows
                .filter(
                  (r) =>
                    String(r[bestGroupCol!]).toLowerCase() ===
                      String(groupKey).toLowerCase() && !isMissingValue(r[col.name])
                )
                .map((r) => String(r[col.name]))
            : [];

        if (peerStrings.length >= 1) {
          guessedValue = modeOfStrings(peerStrings);
          method = 'Conditional Group Mode';
          basisColumns = [bestGroupCol!];
          confidence = Math.min(0.89, 0.65 + peerStrings.length * 0.05);
          explanation = `Guessed as most frequent ${col.name} among rows with ${bestGroupCol} = "${String(groupKey)}".`;
        } else {
          guessedValue = modeOfStrings(nonMissing.map((v) => String(v)));
          method = 'Global Column Mode';
          basisColumns = [col.name];
          confidence = 0.52;
          explanation = `Guessed using global mode across ${nonMissing.length} observed rows.`;
        }
      }

      imputedRows[rowIdx][col.name] = guessedValue;
      const rowIdVal = pkCol ? (rows[rowIdx][pkCol] as string | number | null) : rowIdx + 1;
      imputedCells.push({
        rowIndex: rowIdx,
        rowId: rowIdVal ?? rowIdx + 1,
        tableName,
        columnName: col.name,
        originalValue: originalVal ?? null,
        guessedValue,
        method,
        basisColumns,
        confidence: Math.round(confidence * 100) / 100,
        explanation,
      });
    }
  }

  return { imputedRows, imputedCells };
}

function modeOfStrings(values: string[]): string {
  const counts = new Map<string, number>();
  let best = values[0] ?? 'Unknown';
  let bestCount = 0;
  for (const v of values) {
    const next = (counts.get(v) ?? 0) + 1;
    counts.set(v, next);
    if (next > bestCount) {
      bestCount = next;
      best = v;
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
