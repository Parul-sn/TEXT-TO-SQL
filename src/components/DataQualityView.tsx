import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type {
  AnomalyCleanActionType,
  AnomalyCleanOption,
  AnomalyRecord,
  ColumnSchema,
  DataProfile,
  ImputedCellMeta,
} from '../shared/types';

interface CleanOutcome {
  ok: boolean;
  message?: string;
  appliedSql?: string;
  error?: string;
}

interface DataQualityViewProps {
  profile: DataProfile | null;
  mode: 'database' | 'text_only';
  onCleanAnomaly: (
    anomalyId: string,
    actionType?: string,
    customInstruction?: string
  ) => Promise<CleanOutcome>;
  onCleanCustomColumn: (
    tableName: string,
    columnName: string,
    instruction: string
  ) => Promise<CleanOutcome>;
  onCleanAllAnomalies: () => Promise<void>;
  onResetDatabase: () => Promise<void>;
  onLoadExample: (exampleId: string) => Promise<void>;
  sessionId: string;
}

interface TablePreviewState {
  columns: ColumnSchema[];
  originalRows: Record<string, unknown>[];
  imputedRows: Record<string, unknown>[];
  imputedCells: ImputedCellMeta[];
}

function getOptionsForAnomaly(anom: AnomalyRecord): AnomalyCleanOption[] {
  if (anom.cleaningOptions && anom.cleaningOptions.length > 0) {
    return anom.cleaningOptions;
  }
  if (anom.kind === 'casing_fragmentation') {
    return [
      {
        id: 'normalize_text',
        label: 'Trim & Title Case',
        description: 'Trim extra spaces and convert values to Title Case.',
        recommended: true,
      },
      {
        id: 'normalize_upper',
        label: 'Trim & UPPERCASE',
        description: 'Trim extra spaces and convert values to UPPERCASE.',
      },
      {
        id: 'normalize_lower',
        label: 'Trim & lowercase',
        description: 'Trim extra spaces and convert values to lowercase.',
      },
      {
        id: 'trim_only',
        label: 'Trim Whitespace Only',
        description: 'Remove leading, trailing, and repeated spaces.',
      },
    ];
  }
  if (anom.kind === 'orphan_foreign_key') {
    return [
      {
        id: 'remove_orphan_fk',
        label: 'Set Orphan Keys to NULL',
        description: 'Keep child rows while setting invalid foreign keys to NULL.',
        recommended: true,
      },
      {
        id: 'delete_rows',
        label: 'Delete Orphan Rows',
        description: 'Remove child rows with broken foreign keys.',
      },
    ];
  }
  if (anom.kind === 'negative_domain_violation') {
    return [
      {
        id: 'nullify_and_impute',
        label: 'Nullify & Re-Impute',
        description: 'Set negative/invalid values to NULL for peer imputation.',
        recommended: true,
      },
      {
        id: 'abs_value',
        label: 'Convert Negative to Positive',
        description: 'Convert negative numbers to positive using ABS().',
      },
      {
        id: 'set_zero',
        label: 'Replace Negative with 0',
        description: 'Set negative values to 0.',
      },
      {
        id: 'delete_rows',
        label: 'Delete Affected Rows',
        description: 'Delete rows containing negative or extreme values.',
      },
    ];
  }
  return [
    {
      id: 'clamp_outlier',
      label: 'Clamp to IQR Fence',
      description: 'Clamp extreme values to statistical IQR bounds.',
      recommended: true,
    },
    {
      id: 'nullify_and_impute',
      label: 'Nullify Outliers',
      description: 'Set extreme outliers to NULL for peer imputation.',
    },
    {
      id: 'delete_rows',
      label: 'Delete Outlier Rows',
      description: 'Remove rows outside statistical IQR bounds.',
    },
  ];
}

export const DataQualityView: React.FC<DataQualityViewProps> = ({
  profile,
  mode,
  onCleanAnomaly,
  onCleanCustomColumn,
  onCleanAllAnomalies,
  onResetDatabase,
  onLoadExample,
  sessionId,
}) => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [viewMode, setViewMode] = useState<'imputed' | 'original'>('imputed');
  const [preview, setPreview] = useState<TablePreviewState | null>(null);
  const [loadingTable, setLoadingTable] = useState(false);
  const [cleaningId, setCleaningId] = useState<string | null>(null);

  // Manual option selection & general-language instructions per detected anomaly
  const [selectedActions, setSelectedActions] = useState<Record<string, AnomalyCleanActionType>>({});
  const [rowInstructions, setRowInstructions] = useState<Record<string, string>>({});
  const [cleanFeedback, setCleanFeedback] = useState<CleanOutcome | null>(null);

  // Custom column-level general-language rule bar
  const [ruleTable, setRuleTable] = useState<string>('');
  const [ruleColumn, setRuleColumn] = useState<string>('');
  const [ruleText, setRuleText] = useState<string>('');

  useEffect(() => {
    if (profile && profile.tables.length > 0) {
      const stillExists = profile.tables.some((t) => t.name === selectedTable);
      if (!stillExists) {
        setSelectedTable(profile.tables[0].name);
      }
      const ruleTableObj =
        profile.tables.find((t) => t.name === ruleTable) ?? profile.tables[0];
      if (ruleTableObj.name !== ruleTable) {
        setRuleTable(ruleTableObj.name);
      }
      const colExists = ruleTableObj.columns.some((c) => c.name === ruleColumn);
      if (!colExists && ruleTableObj.columns.length > 0) {
        const preferred =
          ruleTableObj.columns.find((c) => !c.isPrimaryKey) ?? ruleTableObj.columns[0];
        setRuleColumn(preferred.name);
      }
    } else {
      setSelectedTable('');
      setPreview(null);
      setRuleTable('');
      setRuleColumn('');
    }
  }, [profile, selectedTable, ruleTable, ruleColumn]);

  useEffect(() => {
    if (!selectedTable || mode === 'text_only') return;
    let cancelled = false;
    setLoadingTable(true);
    fetch(`/api/db/table/${encodeURIComponent(selectedTable)}`, {
      headers: { 'x-session-id': sessionId },
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && !data.error) {
          setPreview(data);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTable, profile, mode, sessionId]);

  if (mode === 'text_only' || !profile) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center max-w-2xl mx-auto">
        <Database className="w-8 h-8 text-slate-400 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          No Database File Loaded
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5">
          Missing-value imputation and anomaly clearing operate on `.db` or `.sql` databases. Upload a file or load our HR Payroll Missing Imputation example to inspect live data healing.
        </p>
        <button
          type="button"
          onClick={() => onLoadExample('hr_missing_imputation')}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
        >
          <Sparkles className="w-4 h-4" />
          <span>Load HR Missing & Anomaly Example</span>
        </button>
      </div>
    );
  }

  const rowsToShow =
    viewMode === 'imputed' ? preview?.imputedRows ?? [] : preview?.originalRows ?? [];
  const imputedMap = new Map<string, ImputedCellMeta>();
  for (const cell of preview?.imputedCells ?? []) {
    imputedMap.set(`${cell.rowIndex}:${cell.columnName}`, cell);
  }

  const activeRuleTableObj =
    profile.tables.find((t) => t.name === ruleTable) ?? profile.tables[0];
  const ruleColumns = activeRuleTableObj?.columns ?? [];

  const handleApplyAnomalyFix = async (anom: AnomalyRecord) => {
    const options = getOptionsForAnomaly(anom);
    const chosenAction = selectedActions[anom.id] ?? options[0]?.id ?? anom.cleanActionType;
    const customText = (rowInstructions[anom.id] ?? '').trim();

    if (chosenAction === 'custom_instruction' && !customText) {
      setCleanFeedback({
        ok: false,
        error: `Please type a general-language instruction for ${anom.tableName}.${anom.columnName} before applying.`,
      });
      return;
    }

    setCleaningId(anom.id);
    const res = await onCleanAnomaly(
      anom.id,
      chosenAction === 'custom_instruction' ? undefined : chosenAction,
      chosenAction === 'custom_instruction' || customText ? customText : undefined
    );
    setCleanFeedback(res);
    if (res.ok) {
      setRowInstructions((prev) => ({ ...prev, [anom.id]: '' }));
    }
    setCleaningId(null);
  };

  const handleApplyCustomRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleTable || !ruleColumn || !ruleText.trim()) return;
    setCleaningId('custom_rule');
    const res = await onCleanCustomColumn(ruleTable, ruleColumn, ruleText.trim());
    setCleanFeedback(res);
    if (res.ok) {
      setRuleText('');
    }
    setCleaningId(null);
  };

  return (
    <div className="space-y-6">
      {/* KPI Overview Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Total Rows Profiled</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {profile.totalRows}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Missing Cells Detected</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-amber-600 dark:text-amber-400 mt-1">
            {profile.totalMissingCells}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Approximated (Guessed)</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-blue-600 dark:text-blue-400 mt-1">
            {profile.imputedCells.length}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Active Data Anomalies</div>
          <div
            className={`text-2xl font-semibold font-mono tabular-nums mt-1 ${
              profile.totalAnomalies > 0
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {profile.totalAnomalies}
          </div>
        </div>
      </div>

      {/* Anomaly Detection & Manual Clearing Workbench */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Manual Anomaly Clearing &amp; General-Language Rules
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Choose a fix option manually for each detected anomaly, or enter a plain-English instruction in the General Language column.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                setCleanFeedback(null);
                await onResetDatabase();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Original Snapshot</span>
            </button>
            {profile.anomalies.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  setCleaningId('all');
                  await onCleanAllAnomalies();
                  setCleanFeedback({
                    ok: true,
                    message: 'Cleared all remaining anomalies with recommended fixes.',
                  });
                  setCleaningId(null);
                }}
                disabled={cleaningId !== null}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>{cleaningId === 'all' ? 'Clearing…' : 'Auto-Clear All'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Applied Fix / Validation Feedback Banner */}
        {cleanFeedback && (
          <div
            role="status"
            className={`px-5 py-3 border-b text-xs ${
              cleanFeedback.ok
                ? 'border-emerald-200 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100'
                : 'border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-100'
            }`}
          >
            <div className="font-medium">
              {cleanFeedback.ok ? cleanFeedback.message : cleanFeedback.error}
            </div>
            {cleanFeedback.appliedSql && (
              <div className="font-mono text-[11px] opacity-90 mt-1 break-all">
                Executed: {cleanFeedback.appliedSql}
              </div>
            )}
          </div>
        )}

        {profile.anomalies.length === 0 ? (
          <div className="p-8 text-center text-sm text-emerald-700 dark:text-emerald-300 flex flex-col items-center gap-2">
            <CheckCircle2 className="w-6 h-6" />
            <span className="font-medium">Zero active anomalies remaining in this database.</span>
          </div>
        ) : (
          <div className="overflow-x-auto bg-white dark:bg-slate-900">
            <table className="w-full text-left border-collapse text-xs bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950">
                  <th className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-200 min-w-[230px]">
                    Anomaly &amp; Column
                  </th>
                  <th className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-200 min-w-[260px]">
                    Manual Fix Options (Select One)
                  </th>
                  <th className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-200 min-w-[250px]">
                    General Language Rule
                  </th>
                  <th className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                    Apply
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
                {profile.anomalies.map((anom) => {
                  const options = getOptionsForAnomaly(anom);
                  const activeOption =
                    selectedActions[anom.id] ?? options[0]?.id ?? anom.cleanActionType;
                  const customText = rowInstructions[anom.id] ?? '';

                  return (
                    <tr
                      key={anom.id}
                      className="align-top bg-white dark:bg-slate-900 hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
                    >
                      {/* Column 1: Anomaly Details */}
                      <td className="px-4 py-4 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`font-semibold inline-flex items-center gap-1 ${
                              anom.severity === 'high'
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-amber-600 dark:text-amber-400'
                            }`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>{anom.severity.toUpperCase()}</span>
                          </span>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {anom.tableName}.{anom.columnName}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {anom.affectedRowCount} row(s) · Samples: {anom.sampleValues.join(', ')}
                        </div>
                        <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                          {anom.description}
                        </p>
                      </td>

                      {/* Column 2: Selectable Manual Options */}
                      <td className="px-4 py-4">
                        <fieldset className="space-y-2">
                          <legend className="sr-only">
                            Manual cleaning options for {anom.tableName}.{anom.columnName}
                          </legend>
                          {options.map((opt) => {
                            const checked = activeOption === opt.id;
                            return (
                              <label
                                key={opt.id}
                                className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                                  checked
                                    ? 'border-blue-500/60 bg-blue-50/70 dark:bg-blue-950/40'
                                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name={`anom-opt-${anom.id}`}
                                  value={opt.id}
                                  checked={checked}
                                  onChange={() =>
                                    setSelectedActions((prev) => ({
                                      ...prev,
                                      [anom.id]: opt.id,
                                    }))
                                  }
                                  className="mt-0.5 accent-blue-600"
                                />
                                <div className="min-w-0">
                                  <div className="font-medium text-slate-900 dark:text-slate-100">
                                    {opt.label}
                                    {opt.recommended ? (
                                      <span className="ml-1.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-300">
                                        (Recommended)
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                                    {opt.description}
                                  </div>
                                </div>
                              </label>
                            );
                          })}

                          <label
                            className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                              activeOption === 'custom_instruction'
                                ? 'border-blue-500/60 bg-blue-50/70 dark:bg-blue-950/40'
                                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`anom-opt-${anom.id}`}
                              value="custom_instruction"
                              checked={activeOption === 'custom_instruction'}
                              onChange={() =>
                                setSelectedActions((prev) => ({
                                  ...prev,
                                  [anom.id]: 'custom_instruction',
                                }))
                              }
                              className="mt-0.5 accent-blue-600"
                            />
                            <div>
                              <div className="font-medium text-slate-900 dark:text-slate-100">
                                Use General Language Rule
                              </div>
                              <div className="text-[11px] text-slate-600 dark:text-slate-400">
                                Run the plain-English instruction from the next column.
                              </div>
                            </div>
                          </label>
                        </fieldset>
                      </td>

                      {/* Column 3: General Language Input Column */}
                      <td className="px-4 py-4 space-y-2">
                        <label
                          htmlFor={`general-rule-${anom.id}`}
                          className="block text-[11px] font-medium text-slate-700 dark:text-slate-300"
                        >
                          Plain-English Rule for {anom.columnName}
                        </label>
                        <input
                          id={`general-rule-${anom.id}`}
                          type="text"
                          value={customText}
                          onChange={(e) => {
                            const val = e.target.value;
                            setRowInstructions((prev) => ({ ...prev, [anom.id]: val }));
                            if (val.trim()) {
                              setSelectedActions((prev) => ({
                                ...prev,
                                [anom.id]: 'custom_instruction',
                              }));
                            }
                          }}
                          placeholder={
                            anom.kind === 'casing_fragmentation'
                              ? "e.g. convert to uppercase"
                              : anom.kind === 'orphan_foreign_key'
                              ? "e.g. delete orphan rows"
                              : "e.g. set negative values to 0"
                          }
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Examples: &ldquo;set negative values to 0&rdquo;, &ldquo;cap above 500 to 500&rdquo;, &ldquo;replace &apos;a&apos; with &apos;b&apos;&rdquo;, &ldquo;trim and title case&rdquo;
                        </div>
                      </td>

                      {/* Column 4: Apply Button */}
                      <td className="px-4 py-4 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={cleaningId !== null}
                          onClick={() => handleApplyAnomalyFix(anom)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap"
                        >
                          <Wrench className="w-3.5 h-3.5" />
                          <span>{cleaningId === anom.id ? 'Applying…' : 'Apply Selected Fix'}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Custom Any-Column Cleaning Bar in General Language */}
        <div className="p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Custom Column Cleaning (General Language)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Target any table and column—even without an auto-detected anomaly—and describe how to clean or transform it in plain English.
            </p>
          </div>

          <form
            onSubmit={handleApplyCustomRule}
            className="grid grid-cols-1 md:grid-cols-[180px_180px_1fr_auto] gap-3 items-end"
          >
            <div>
              <label
                htmlFor="custom-clean-table"
                className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Table
              </label>
              <select
                id="custom-clean-table"
                value={ruleTable}
                onChange={(e) => {
                  const nextTbl = e.target.value;
                  setRuleTable(nextTbl);
                  const found = profile.tables.find((t) => t.name === nextTbl);
                  const nextCol =
                    found?.columns.find((c) => !c.isPrimaryKey)?.name ??
                    found?.columns[0]?.name ??
                    '';
                  setRuleColumn(nextCol);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-900 dark:text-slate-100"
              >
                {profile.tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="custom-clean-column"
                className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Column
              </label>
              <select
                id="custom-clean-column"
                value={ruleColumn}
                onChange={(e) => setRuleColumn(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-900 dark:text-slate-100"
              >
                {ruleColumns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="custom-clean-instruction"
                className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                General Language Instruction
              </label>
              <input
                id="custom-clean-instruction"
                type="text"
                value={ruleText}
                onChange={(e) => setRuleText(e.target.value)}
                placeholder="e.g., set negative values to 0, or trim spaces and uppercase, or fill missing with Unknown"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={cleaningId !== null || !ruleText.trim()}
              className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap"
            >
              {cleaningId === 'custom_rule' ? 'Applying…' : 'Apply Rule'}
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500 dark:text-slate-400 font-medium">Quick presets:</span>
            {[
              'set negative values to 0',
              'convert negative to positive',
              'cap values above 500 to 500',
              'trim spaces and title case',
              'fill missing with Unknown',
              'delete rows with negative values',
            ].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRuleText(preset)}
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 dark:hover:border-blue-500 text-slate-700 dark:text-slate-300 text-[11px]"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Missing Value Inspector & Table Preview (Original vs Guessed/Filled) */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Missing-Value Imputation Inspector (Explicitly Tagged as GUESSED)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Compare raw NULL/N/A cells against peer-group approximated values. Every filled cell explicitly discloses that it was missing and how it was guessed.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Select table to inspect"
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200"
            >
              {profile.tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.rowCount} rows)
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setViewMode('imputed')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  viewMode === 'imputed'
                    ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Guessed / Filled View
              </button>
              <button
                type="button"
                onClick={() => setViewMode('original')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  viewMode === 'original'
                    ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Raw Original Data
              </button>
            </div>
          </div>
        </div>

        {/* Imputation Provenance Ledger */}
        {preview && preview.imputedCells.length > 0 && (
          <div className="px-5 py-3 bg-amber-50/70 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/60">
            <div className="text-xs font-semibold text-amber-900 dark:text-amber-200 mb-1.5">
              Imputation Provenance Log for {selectedTable} ({preview.imputedCells.length} filled cell(s))
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {preview.imputedCells.map((cell, i) => (
                <div
                  key={i}
                  className="text-xs text-amber-900 dark:text-amber-100 bg-white/70 dark:bg-slate-900/70 border border-amber-200/80 dark:border-amber-800/60 rounded-md px-3 py-2"
                >
                  <span className="font-mono font-semibold">
                    Row #{String(cell.rowId)} · {cell.columnName}
                  </span>{' '}
                  was missing (<code className="font-mono">{String(cell.originalValue || 'NULL')}</code>) →{' '}
                  <strong className="font-mono text-amber-700 dark:text-amber-300">
                    GUESSED: {String(cell.guessedValue)}
                  </strong>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                    {cell.method} ({cell.explanation}) · Confidence {Math.round(cell.confidence * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loadingTable ? (
          <div className="p-8 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Profiling table rows…</span>
          </div>
        ) : (
          <div className="overflow-x-auto bg-white dark:bg-slate-900">
            <table className="w-full text-left border-collapse text-xs bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950">
                  {(preview?.columns ?? []).map((col) => (
                    <th
                      key={col.name}
                      className="px-4 py-2.5 font-mono font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap"
                    >
                      {col.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
                {rowsToShow.map((row, rIdx) => (
                  <tr key={rIdx} className="bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    {(preview?.columns ?? []).map((col) => {
                      const val = row[col.name];
                      const meta = imputedMap.get(`${rIdx}:${col.name}`);
                      const showGuessed = viewMode === 'imputed' && Boolean(meta);

                      return (
                        <td
                          key={col.name}
                          className={`px-4 py-2.5 font-mono whitespace-nowrap ${
                            typeof val === 'number' ? 'tabular-nums' : ''
                          } ${
                            showGuessed
                              ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-950 dark:text-amber-200'
                              : 'text-slate-900 dark:text-slate-100'
                          }`}
                        >
                          {showGuessed && meta ? (
                            <span title={meta.explanation}>
                              <strong>{String(val)}</strong>{' '}
                              <span className="text-[10px] font-sans font-semibold text-amber-800 dark:text-amber-300">
                                (GUESSED · WAS MISSING)
                              </span>
                            </span>
                          ) : val === null || val === undefined || val === '' ? (
                            <span className="text-rose-700 dark:text-rose-400 italic font-medium">
                              {val === '' ? 'EMPTY' : 'NULL'}
                            </span>
                          ) : (
                            <span className="text-slate-900 dark:text-slate-100">{String(val)}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
