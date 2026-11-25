import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Download,
  FileCode2,
  HelpCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type {
  CandidatePathQuery,
  DataProfile,
  ImputedCellMeta,
  ShowcaseExample,
  TextToSqlResponse,
} from '../shared/types';
import { SchemaGraphCanvas } from './SchemaGraphCanvas';

interface QueryStudioViewProps {
  mode: 'database' | 'text_only';
  sourceName: string;
  exampleId?: string;
  examples: ShowcaseExample[];
  profile: DataProfile | null;
  question: string;
  onQuestionChange: (q: string) => void;
  onGenerateSql: (questionOverride?: string, forceTextOnly?: boolean) => Promise<void>;
  onExecuteManualSql: (sql: string) => Promise<void>;
  onSelectExample: (exampleId: string) => Promise<void>;
  onSwitchToDataQuality: () => void;
  sqlResult: TextToSqlResponse | null;
  isGenerating: boolean;
  errorMsg: string | null;
}

export const QueryStudioView: React.FC<QueryStudioViewProps> = ({
  mode,
  sourceName,
  exampleId,
  examples,
  profile,
  question,
  onQuestionChange,
  onGenerateSql,
  onExecuteManualSql,
  onSelectExample,
  onSwitchToDataQuality,
  sqlResult,
  isGenerating,
  errorMsg,
}) => {
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [hoveredCandidateId, setHoveredCandidateId] = useState<string | null>(null);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [showManualEditor, setShowManualEditor] = useState(false);
  const [manualSql, setManualSql] = useState('');
  const [selectedCellProvenance, setSelectedCellProvenance] =
    useState<ImputedCellMeta | null>(null);

  const activeExample = examples.find((e) => e.id === exampleId);
  const candidates = sqlResult?.candidates ?? [];
  const displayedCandidate: CandidatePathQuery | null =
    candidates.find((c) => c.id === activeCandidateId) ??
    candidates.find((c) => c.selected) ??
    candidates[0] ??
    null;

  const activeSql = displayedCandidate?.sql ?? sqlResult?.selectedSql ?? '';
  const activeExecution = displayedCandidate?.execution ?? sqlResult?.result ?? null;

  const toggleTable = (tableName: string) => {
    setExpandedTables((prev) => ({ ...prev, [tableName]: !prev[tableName] }));
  };

  const handleSelectCandidate = (cand: CandidatePathQuery) => {
    setActiveCandidateId(cand.id);
    setManualSql(cand.sql);
  };

  const handleExportCsv = () => {
    if (!activeExecution || activeExecution.columns.length === 0) return;
    const cols = activeExecution.columns;
    const header = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
    const lines = activeExecution.rows.map((row) =>
      cols
        .map((c) => {
          const val = row[c] === null || row[c] === undefined ? '' : String(row[c]);
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'graphsql_results.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[276px_1fr] gap-6 items-start">
      {/* Left Sidebar: Sources, Examples & Schema Explorer */}
      <aside className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
            Showcase Datasets & Modes
          </div>
          <div className="space-y-1.5">
            {examples.map((ex) => {
              const isActive = exampleId === ex.id;
              return (
                <button
                  key={ex.id}
                  type="button"
                  onClick={() => {
                    setActiveCandidateId(null);
                    onSelectExample(ex.id);
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors border ${
                    isActive
                      ? 'border-blue-600/40 dark:border-blue-500/40 bg-blue-50/80 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100 font-medium'
                      : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{ex.title}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {ex.category}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active DB Telemetry Summary */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>Active Source</span>
            </span>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              {mode === 'database' ? 'SQLite' : 'Text-Only'}
            </span>
          </div>
          <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
            {sourceName}
          </div>
          {profile && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-400">
              <span>{profile.tables.length} tables</span>
              <span aria-hidden="true">·</span>
              <span>{profile.totalRows} rows</span>
              <span aria-hidden="true">·</span>
              <span className={profile.totalMissingCells > 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
                {profile.totalMissingCells} missing
              </span>
              <span aria-hidden="true">·</span>
              <span className={profile.totalAnomalies > 0 ? 'text-rose-600 dark:text-rose-400 font-medium' : ''}>
                {profile.totalAnomalies} anomalies
              </span>
            </div>
          )}
          {profile && (profile.totalAnomalies > 0 || profile.totalMissingCells > 0) && (
            <button
              type="button"
              onClick={onSwitchToDataQuality}
              className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-amber-300 dark:border-amber-700/70 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/70 transition-colors"
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Inspect Missing & Anomalies</span>
            </button>
          )}
        </div>

        {/* Schema Tree */}
        <div className="p-4">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
            Schema Tables & Columns
          </div>
          {!profile || profile.tables.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              No `.db` or `.sql` file attached. Enter any business question and GraphSQL will infer a normalized schema and generate SQL from text only.
            </p>
          ) : (
            <div className="space-y-1">
              {profile.tables.map((t) => {
                const isOpen = expandedTables[t.name] ?? true;
                return (
                  <div key={t.name} className="rounded-lg border border-slate-200/80 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => toggleTable(t.name)}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        {isOpen ? (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                        )}
                        <span className="font-mono truncate">{t.name}</span>
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                        {t.rowCount}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="px-2.5 pb-2 pt-1 space-y-1 border-t border-slate-100 dark:border-slate-800/80">
                        {t.columns.map((c) => (
                          <div
                            key={c.name}
                            className="flex items-center justify-between gap-2 text-[11px] font-mono py-0.5"
                          >
                            <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 truncate">
                              <span
                                className={
                                  c.isPrimaryKey
                                    ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                    : c.isForeignKey
                                    ? 'text-blue-600 dark:text-blue-400 font-semibold'
                                    : 'text-slate-400 dark:text-slate-600'
                                }
                              >
                                {c.isPrimaryKey ? 'PK' : c.isForeignKey ? 'FK' : '·'}
                              </span>
                              <span className="truncate">{c.name}</span>
                            </span>
                            <span className="text-slate-400 dark:text-slate-500 shrink-0">
                              {c.missingCount > 0 || c.anomalyCount > 0 ? (
                                <span className="text-amber-600 dark:text-amber-400">
                                  {c.missingCount > 0 ? `${c.missingCount}m` : ''}
                                  {c.anomalyCount > 0 ? ` ${c.anomalyCount}a` : ''}
                                </span>
                              ) : (
                                c.type.slice(0, 6)
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Main Query & Graph Column */}
      <div className="space-y-6 min-w-0">
        {/* Prompt Input Card */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Natural Language to SQL Studio
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {activeExample
                  ? activeExample.highlightFeature
                  : 'Generates multi-path candidate queries, heals SQLite errors up to 5 retries, and profiles missing values.'}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
              {mode === 'database' ? 'Database-Grounded · Max 5 Self-Heal Retries' : 'Text-Only Inferred DDL Mode'}
            </span>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setActiveCandidateId(null);
              onGenerateSql(question, mode === 'text_only');
            }}
            className="flex flex-col sm:flex-row gap-3"
          >
            <label htmlFor="nl-question-input" className="sr-only">
              Natural language SQL question
            </label>
            <input
              id="nl-question-input"
              type="text"
              value={question}
              onChange={(e) => onQuestionChange(e.target.value)}
              placeholder="Ask a question in plain English (e.g., Show total verified order amount per customer name and region)..."
              className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={isGenerating || !question.trim()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            >
              {isGenerating ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Generating & Healing…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Generate & Execute</span>
                </>
              )}
            </button>
          </form>

          {/* Sample Questions Bar */}
          {activeExample && activeExample.sampleQuestions.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500 dark:text-slate-400 font-medium">
                Try example prompt:
              </span>
              {activeExample.sampleQuestions.map((sq, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    onQuestionChange(sq);
                    setActiveCandidateId(null);
                    onGenerateSql(sq, activeExample.mode === 'text_only');
                  }}
                  className="text-left px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 hover:border-blue-400 dark:hover:border-blue-500 text-slate-700 dark:text-slate-300 transition-colors text-xs"
                >
                  {sq}
                </button>
              ))}
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="mt-4 p-3.5 rounded-lg border border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Execution Error</div>
                <div className="mt-0.5">{errorMsg}</div>
              </div>
            </div>
          )}
        </section>

        {/* Multi-Path Candidate Queries (Selected vs Not Selected) + Self-Healing Log */}
        {sqlResult && (
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Cost-Ranked Multi-Path Candidates ({candidates.length} Generated)
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 max-w-3xl leading-relaxed">
                  {sqlResult.explanation}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                {sqlResult.llmMeta && (
                  <>
                    <span>
                      Key #{sqlResult.llmMeta.keySlot}/{sqlResult.llmMeta.totalKeysConfigured}
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>
                  Attempts: {sqlResult.totalAttempts}/6
                </span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    sqlResult.healedOnRetry
                      ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                      : ''
                  }
                >
                  {sqlResult.healedOnRetry ? 'Self-Healed on Retry' : 'First-Pass Execution'}
                </span>
              </div>
            </div>

            {sqlResult.llmMeta && sqlResult.llmMeta.failovers.length > 0 && (
              <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                <div className="font-semibold">Automatic API Key Failover Triggered</div>
                {sqlResult.llmMeta.failovers.map((ev, i) => (
                  <div key={i} className="font-mono text-[11px]">
                    {ev}
                  </div>
                ))}
              </div>
            )}

            {/* Candidate Cards Grid */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {candidates.map((cand) => {
                const isViewing = displayedCandidate?.id === cand.id;
                const cost = cand.costBreakdown;
                return (
                  <div
                    key={cand.id}
                    onMouseEnter={() => setHoveredCandidateId(cand.id)}
                    onMouseLeave={() => setHoveredCandidateId(null)}
                    className={`rounded-lg border p-4 transition-colors ${
                      cand.selected
                        ? 'border-emerald-500/60 dark:border-emerald-500/50 bg-emerald-50/40 dark:bg-emerald-950/20'
                        : isViewing
                        ? 'border-blue-500/60 bg-blue-50/40 dark:bg-blue-950/20'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        {cand.selected ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Selected Lowest-Cost Query</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                            <span>Not Selected Alternative</span>
                          </span>
                        )}
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          {cand.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-2.5 text-xs font-mono tabular-nums">
                        {cand.queryCost !== undefined && (
                          <span
                            className={`font-semibold ${
                              cand.selected
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            Cost {cand.queryCost}
                          </span>
                        )}
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
                        <span className="font-semibold text-blue-700 dark:text-blue-300">
                          Resilience {cand.resilienceScore}
                        </span>
                      </div>
                    </div>

                    {/* Path & Cost Breakdown Metadata */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-400 mb-2">
                      <span>Path: {cand.graphPathTables.join(' → ') || 'Inferred'}</span>
                      <span aria-hidden="true">·</span>
                      <span>Hops: {cand.hopCount}</span>
                      <span aria-hidden="true">·</span>
                      <span className={cand.anomalyPenalty > 0 ? 'text-rose-600 dark:text-rose-400 font-medium' : ''}>
                        Anomaly Penalty: {cand.anomalyPenalty}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Null Loss: {cand.nullLossRate}</span>
                    </div>

                    {cost && (
                      <div className="mb-2.5 px-2.5 py-1.5 rounded-md bg-white/80 dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-800 text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-300 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                          <span>Plan {cost.planCost}</span>
                          <span aria-hidden="true">·</span>
                          <span>Join {cost.joinCost}</span>
                          <span aria-hidden="true">·</span>
                          <span className={cost.anomalyCost > 0 ? 'text-rose-600 dark:text-rose-400 font-semibold' : ''}>
                            Anomaly {cost.anomalyCost}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Semantic {cost.semanticCost}</span>
                          <span aria-hidden="true">·</span>
                          <span>Latency {cost.latencyCost}</span>
                          {cost.failureCost > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                Error +{cost.failureCost}
                              </span>
                            </>
                          )}
                        </div>
                        {cost.planSteps.length > 0 && (
                          <div className="text-[10.5px] text-slate-500 dark:text-slate-400 truncate" title={cost.planSteps.join(' | ')}>
                            EXPLAIN: {cost.planSteps.join(' → ')}
                          </div>
                        )}
                      </div>
                    )}

                    <pre className="p-2.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11.5px] font-mono text-slate-800 dark:text-slate-200 overflow-x-auto whitespace-pre-wrap">
                      {cand.sql}
                    </pre>

                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-slate-600 dark:text-slate-400 flex-1 min-w-[200px]">
                        {cand.selectionReason}
                      </p>
                      {!isViewing && (
                        <button
                          type="button"
                          onClick={() => handleSelectCandidate(cand)}
                          className="px-2.5 py-1 rounded-md text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0"
                        >
                          Inspect This Path
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 5-Retry Self-Healing Trace */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2.5">
                Self-Healing Execution & Repair Trace (Max 5 Retries)
              </div>
              <div className="space-y-2">
                {sqlResult.repairAttempts.map((att) => (
                  <div
                    key={att.attemptNumber}
                    className="flex flex-wrap items-start justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-xs"
                  >
                    <div className="flex items-start gap-2.5">
                      {att.status === 'success' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {att.isInitial
                            ? 'Attempt 1 (Initial Generation)'
                            : `Retry ${att.attemptNumber - 1}/5 (Self-Healing Repair)`}
                          {' · '}
                          <span
                            className={
                              att.status === 'success'
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-rose-700 dark:text-rose-300'
                            }
                          >
                            {att.status === 'success' ? 'Succeeded' : 'Failed'}
                          </span>
                        </div>
                        {att.diagnosis && (
                          <div className="text-slate-600 dark:text-slate-400 mt-0.5">
                            {att.diagnosis}
                          </div>
                        )}
                        {att.errorMessage && (
                          <div className="font-mono text-[11px] text-rose-700 dark:text-rose-300 mt-1">
                            SQLite Error: {att.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
                      {att.executionMs} ms
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Interactive Dual Graph Canvas (Schema & Column Graph + Query Execution Graph) */}
        <SchemaGraphCanvas
          tables={profile?.tables ?? []}
          edges={profile?.edges ?? []}
          queryGraph={sqlResult?.queryGraph ?? null}
          candidates={candidates}
          hoveredCandidateId={hoveredCandidateId}
          inferredDdl={sqlResult?.inferredDdl}
        />

        {/* Inferred DDL (when in Text-Only Mode) */}
        {sqlResult?.inferredDdl && (
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <FileCode2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span>Inferred Relational DDL (Text-Only Mode)</span>
              </h2>
            </div>
            <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto">
              {sqlResult.inferredDdl}
            </pre>
          </section>
        )}

        {/* Query Execution Output & Provenance-Tagged Results Table */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Query Output & Missing-Value Imputation Overlay
              </h2>
              {activeExecution && (
                <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {activeExecution.rowCount} row(s) · {activeExecution.executionMs} ms
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setManualSql(activeSql);
                  setShowManualEditor((s) => !s);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>{showManualEditor ? 'Hide SQL Editor' : 'Edit & Run SQL'}</span>
              </button>
              {activeExecution && activeExecution.rows.length > 0 && (
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV</span>
                </button>
              )}
            </div>
          </div>

          {showManualEditor && (
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-2.5">
              <label htmlFor="manual-sql-editor" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Manual SQLite Query Editor (Read-Only SELECT / WITH / PRAGMA)
              </label>
              <textarea
                id="manual-sql-editor"
                rows={4}
                value={manualSql}
                onChange={(e) => setManualSql(e.target.value)}
                className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => onExecuteManualSql(manualSql)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Run SQL</span>
                </button>
              </div>
            </div>
          )}

          {/* Data / Imputation Warnings */}
          {sqlResult?.dataWarnings && sqlResult.dataWarnings.length > 0 && (
            <div className="px-5 py-2.5 bg-amber-50/70 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 space-y-1">
              {sqlResult.dataWarnings.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Provenance Detail Banner when user clicks a GUESSED cell */}
          {selectedCellProvenance && (
            <div className="px-5 py-3 bg-amber-50 dark:bg-amber-950/50 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-100 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>
                  <strong>GUESSED VALUE PROVENANCE</strong> — Column{' '}
                  <code className="font-mono">{selectedCellProvenance.columnName}</code> was originally missing (
                  <code className="font-mono">{String(selectedCellProvenance.originalValue)}</code>) and filled with{' '}
                  <strong className="font-mono">{String(selectedCellProvenance.guessedValue)}</strong> using{' '}
                  <em>{selectedCellProvenance.method}</em> ({selectedCellProvenance.explanation} · Confidence{' '}
                  {Math.round(selectedCellProvenance.confidence * 100)}%).
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCellProvenance(null)}
                className="text-xs underline text-amber-800 dark:text-amber-300"
              >
                Dismiss
              </button>
            </div>
          )}

          {!activeExecution ? (
            <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              Submit a natural-language question above or click an example prompt to generate SQL and inspect live execution results.
            </div>
          ) : activeExecution.error ? (
            <div className="p-6 text-sm text-rose-700 dark:text-rose-300 font-mono">
              {activeExecution.error}
            </div>
          ) : activeExecution.rows.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              {mode === 'text_only'
                ? 'Query validated cleanly against inferred DDL schema. Upload a .db or .sql file to execute against live data rows.'
                : 'Query executed cleanly and returned 0 rows.'}
            </div>
          ) : (
            <div className="overflow-x-auto bg-white dark:bg-slate-900">
              <table className="w-full text-left border-collapse text-xs bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950">
                    {activeExecution.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-2.5 font-mono font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
                  {activeExecution.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                    >
                      {activeExecution.columns.map((col) => {
                        const meta = activeExecution.imputedCellMarkers?.[String(rIdx)]?.[col];
                        const val = row[col];
                        const isNum = typeof val === 'number';
                        return (
                          <td
                            key={col}
                            className={`px-4 py-2.5 font-mono whitespace-nowrap ${
                              isNum ? 'tabular-nums' : ''
                            } ${
                              meta
                                ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-950 dark:text-amber-200'
                                : 'text-slate-900 dark:text-slate-100'
                            }`}
                          >
                            {meta ? (
                              <button
                                type="button"
                                onClick={() => setSelectedCellProvenance(meta)}
                                title={meta.explanation}
                                className="inline-flex items-center gap-1.5 text-left underline decoration-amber-400/80 underline-offset-2 text-amber-950 dark:text-amber-200"
                              >
                                <span className="font-semibold">{String(val)}</span>
                                <span className="text-[10px] font-sans font-semibold text-amber-800 dark:text-amber-300">
                                  (GUESSED · WAS MISSING)
                                </span>
                              </button>
                            ) : val === null || val === undefined ? (
                              <span className="text-slate-600 dark:text-slate-400 italic">NULL</span>
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
    </div>
  );
};
