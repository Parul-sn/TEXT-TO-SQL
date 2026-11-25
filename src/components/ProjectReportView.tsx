import React from 'react';
import { Download, Printer } from 'lucide-react';
import type { DataProfile, SpiderBenchmarkSummary, TextToSqlResponse } from '../shared/types';

interface ProjectReportViewProps {
  profile: DataProfile | null;
  lastQuery: TextToSqlResponse | null;
  benchmarkSummary: SpiderBenchmarkSummary | null;
  sourceName: string;
}

export const ProjectReportView: React.FC<ProjectReportViewProps> = ({
  profile,
  lastQuery,
  benchmarkSummary,
  sourceName,
}) => {
  const buildMarkdownReport = () => {
    const exAcc = benchmarkSummary ? `${benchmarkSummary.executionAccuracy}%` : 'Pending Run';
    const f1Score = benchmarkSummary ? `${benchmarkSummary.avgComponentF1}%` : 'Pending Run';
    return `# AAMG-SQL: Anomaly-Aware Multi-Path Graph-Guided Text-to-SQL with Self-Healing & Provenance-Tagged Imputation

## 1. Executive Summary & Novel Research Contribution
Existing open-source Text-to-SQL systems (DIN-SQL, DAIL-SQL, CHESS, MAC-SQL) assume clean, unambiguous schemas and emit a single linear SQL string. In real-world databases containing missing values, statistical outliers, casing drift, or corrupted foreign-key shortcuts, single-path SQL generation silently drops records or yields distorted aggregates.

**GraphSQL Studio** implements **AAMG-SQL**, a novel pipeline not previously unified in open-source benchmarks:
1. **Live Schema-Graph Telemetry**: Profiles every column and foreign-key edge in \`.db\` / \`.sql\` inputs for missingness rates, orphan FK counts, IQR outliers, and casing fragmentation.
2. **Multi-Path Graph Enumeration & Resilience Scoring**: Enumerates competing join paths across the schema graph and ranks candidate SQL queries via:
   \`Resilience(p) = 0.48 * SemanticFit + 0.22 * HopParsimony + ExecBonus - 0.38 * AnomalyPenalty - 0.20 * NullLossRate\`
3. **Bounded 5-Retry Execution-Guided Self-Healing**: Executes candidates in-process via Python 3.11 native \`sqlite3\` and feeds exact SQLite error traces back to the \`.env\`-configured LLM (\`LLM_MODEL\`) for up to 5 iterative repair rounds.
4. **Provenance-Tagged Cross-Column Imputation**: Approximates missing cells using peer-group statistics and explicitly flags every filled cell as \`GUESSED (WAS MISSING)\` with method, confidence, and correlated source columns.

## 2. Step-by-Step Methodology
1. **Input Ingestion (Text-Only, .sql, or .db)**: Loads binary SQLite files or SQL scripts into Python \`sqlite3\` session sandboxes, or generates inferred relational DDL in Text-Only mode.
2. **Schema & Integrity Profiling**: Introspects \`PRAGMA table_info\` and \`PRAGMA foreign_key_list\`, infers missing FKs, and measures column-level missingness and edge orphan rates.
3. **Anomaly Detection & Remediation**: Detects IQR numeric outliers, negative domain violations, orphan foreign keys, and casing fragmentation; provides 1-click SQL remediation with snapshot rollback.
4. **Multi-Path Candidate Generation**: Enumerates alternative schema paths and generates 2–3 candidate SQL queries with explicit Selected vs. Not Selected justification.
5. **5-Retry Self-Healing Loop**: Executes SQLite queries in Python and runs up to 5 iterative error-repair cycles on syntax, schema, or aggregation errors.
6. **Column-to-Column & Relational DAG Visualization**: Renders exact column-port Bezier edges and parses SQL into a relational operator DAG (\`SCAN -> JOIN -> FILTER -> GROUP -> SORT -> PROJECT\`).
7. **Official Spider Benchmark Evaluation**: Evaluates N user-selected test cases from the locally stored Yale Official Spider 1.0 Dev Split (1,034 tasks across 166 SQLite databases) against Ground-Truth Gold SQL.

## 3. Live Synchronized Experimental Metrics
- **Active Workspace Source**: ${sourceName}
- **Profiled Tables / Rows**: ${profile ? `${profile.tables.length} tables / ${profile.totalRows} rows` : 'Text-Only Mode'}
- **Missing Cells / Anomalies Detected**: ${profile ? `${profile.totalMissingCells} missing / ${profile.totalAnomalies} anomalies` : 'N/A'}
- **Last Query Attempts Used**: ${lastQuery ? `${lastQuery.totalAttempts}/6 (${lastQuery.candidates.length} candidate paths evaluated)` : 'No query run yet'}
- **Spider Execution Accuracy (EX)**: ${exAcc}
- **Spider Avg Component Match F1**: ${f1Score}
`;
  };

  const handleExportMarkdown = () => {
    const md = buildMarkdownReport();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'GraphSQL_Project_Report.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article className="space-y-8 max-w-5xl mx-auto pb-12">
      {/* Report Title Header */}
      <header className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8">
        <div className="flex flex-wrap lg:flex-nowrap items-start justify-between gap-6">
          <div className="space-y-2 max-w-3xl">
            <div className="text-xs font-mono text-blue-600 dark:text-blue-400 font-semibold">
              Final Project Technical Report & Architecture Presentation
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 [text-wrap:balance]">
              Anomaly-Aware Multi-Path Graph-Guided Text-to-SQL with Self-Healing & Provenance-Tagged Imputation
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              A unified full-stack system combining .env-configurable LLM SQL synthesis, multi-path foreign-key resilience scoring, 5-retry execution-guided repair, cross-column missing-value approximation, and Spider benchmark verification.
            </p>
          </div>

          <div className="flex items-center gap-2 no-print">
            <button
              type="button"
              onClick={handleExportMarkdown}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export .md</span>
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print / Save PDF</span>
            </button>
          </div>
        </div>
      </header>

      {/* Section 1: Novel Contribution */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          01. Novel Research Contribution (Beyond Existing GitHub Text-to-SQL Projects)
        </h2>
        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
          State-of-the-art open-source Text-to-SQL frameworks such as DIN-SQL, DAIL-SQL, MAC-SQL, and CHESS treat relational schemas as noise-free graphs and generate a single SQL query. When applied to real-world databases with orphan foreign keys, extreme numeric outliers, casing drift, or missing values, those systems either return silent join losses or distorted aggregations.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Path-Resilience Graph Scoring
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              Schema edges carry live orphan-key and missingness penalties. When multiple join paths exist between entities, AAMG-SQL generates candidate SQL for each path, ranks them, and presents both the Selected Best query and Not-Selected alternatives.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Provenance-Tagged Imputation
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              Missing cells in raw tables and query outputs are approximated via conditional peer-group mean/mode and explicitly labeled as <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">GUESSED · WAS MISSING</span> with full source-column provenance.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Closed-Loop 5-Retry Healing
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              Every query executes inside an isolated Python <code className="font-mono">sqlite3</code> read-only sandbox. SQLite runtime errors trigger up to 5 iterative LLM repair cycles with exact error diagnosis and latency tracking.
            </p>
          </div>
        </div>
      </section>

      {/* Section 2: System Architecture Diagram (Custom SVG) */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            02. System Architecture Diagram
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            End-to-End Full-Stack Pipeline
          </span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4">
          <svg
            viewBox="0 0 920 340"
            className="w-full min-w-[740px] h-auto"
            role="img"
            aria-label="GraphSQL Studio System Architecture Diagram"
          >
            <defs>
              <marker
                id="arch-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" className="fill-blue-600 dark:fill-blue-400" />
              </marker>
            </defs>

            {/* Layer 1: Inputs */}
            <rect x="20" y="30" width="175" height="280" rx="8" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
            <text x="107" y="54" textAnchor="middle" className="text-[12px] font-semibold fill-slate-900 dark:fill-slate-100">
              1. Input Ingestion
            </text>
            <rect x="36" y="75" width="143" height="52" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="107" y="98" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">Natural Language</text>
            <text x="107" y="114" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">Text-Only Mode</text>

            <rect x="36" y="145" width="143" height="52" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="107" y="168" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">.SQL Script Files</text>
            <text x="107" y="184" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">DDL + Seed Inserts</text>

            <rect x="36" y="215" width="143" height="52" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="107" y="238" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">.DB / .SQLite Binary</text>
            <text x="107" y="254" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">Python sqlite3 Engine</text>

            {/* Arrow 1 -> 2 */}
            <line x1="195" y1="170" x2="235" y2="170" strokeWidth="2" markerEnd="url(#arch-arrow)" className="stroke-blue-600 dark:stroke-blue-400" />

            {/* Layer 2: Profiler & Graph Engine */}
            <rect x="240" y="30" width="205" height="280" rx="8" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
            <text x="342" y="54" textAnchor="middle" className="text-[12px] font-semibold fill-slate-900 dark:fill-slate-100">
              2. Graph & Quality Profiler
            </text>
            <rect x="256" y="75" width="173" height="62" rx="6" className="fill-blue-50 dark:fill-blue-950/40 stroke-blue-300 dark:stroke-blue-700" />
            <text x="342" y="98" textAnchor="middle" className="text-[11px] font-semibold fill-blue-900 dark:fill-blue-100">Schema & FK Graph</text>
            <text x="342" y="114" textAnchor="middle" className="text-[10px] font-mono fill-blue-700 dark:fill-blue-300">Column-Port Topology</text>
            <text x="342" y="128" textAnchor="middle" className="text-[10px] font-mono fill-blue-700 dark:fill-blue-300">Multi-Path BFS/DFS</text>

            <rect x="256" y="152" width="173" height="62" rx="6" className="fill-amber-50 dark:fill-amber-950/40 stroke-amber-300 dark:stroke-amber-700" />
            <text x="342" y="175" textAnchor="middle" className="text-[11px] font-semibold fill-amber-900 dark:fill-amber-100">Missingness & Imputation</text>
            <text x="342" y="191" textAnchor="middle" className="text-[10px] font-mono fill-amber-700 dark:fill-amber-300">Peer-Group Mean / Mode</text>
            <text x="342" y="205" textAnchor="middle" className="text-[10px] font-mono fill-amber-700 dark:fill-amber-300">GUESSED Provenance Tag</text>

            <rect x="256" y="229" width="173" height="62" rx="6" className="fill-rose-50 dark:fill-rose-950/40 stroke-rose-300 dark:stroke-rose-700" />
            <text x="342" y="252" textAnchor="middle" className="text-[11px] font-semibold fill-rose-900 dark:fill-rose-100">Anomaly Detector</text>
            <text x="342" y="268" textAnchor="middle" className="text-[10px] font-mono fill-rose-700 dark:fill-rose-300">IQR, Orphan FK, Casing</text>
            <text x="342" y="282" textAnchor="middle" className="text-[10px] font-mono fill-rose-700 dark:fill-rose-300">1-Click SQL Remediation</text>

            {/* Arrow 2 -> 3 */}
            <line x1="445" y1="170" x2="485" y2="170" strokeWidth="2" markerEnd="url(#arch-arrow)" className="stroke-blue-600 dark:stroke-blue-400" />

            {/* Layer 3: Multi-Path Synthesis & 5-Retry Healing */}
            <rect x="490" y="30" width="205" height="280" rx="8" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
            <text x="592" y="54" textAnchor="middle" className="text-[12px] font-semibold fill-slate-900 dark:fill-slate-100">
              3. Synthesis & Self-Healing
            </text>
            <rect x="506" y="75" width="173" height="62" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="592" y="98" textAnchor="middle" className="text-[11px] font-semibold fill-slate-900 dark:fill-slate-100">.env LLM Provider</text>
            <text x="592" y="114" textAnchor="middle" className="text-[10px] font-mono fill-slate-600 dark:fill-slate-400">Multi-Path SQL Candidates</text>
            <text x="592" y="128" textAnchor="middle" className="text-[10px] font-mono fill-slate-600 dark:fill-slate-400">LLM_BASE_URL + LLM_MODEL</text>

            <rect x="506" y="152" width="173" height="62" rx="6" className="fill-emerald-50 dark:fill-emerald-950/40 stroke-emerald-300 dark:stroke-emerald-700" />
            <text x="592" y="175" textAnchor="middle" className="text-[11px] font-semibold fill-emerald-900 dark:fill-emerald-100">5-Retry Repair Loop</text>
            <text x="592" y="191" textAnchor="middle" className="text-[10px] font-mono fill-emerald-700 dark:fill-emerald-300">Execute -&gt; Catch Error</text>
            <text x="592" y="205" textAnchor="middle" className="text-[10px] font-mono fill-emerald-700 dark:fill-emerald-300">Diagnose &amp; Regenerate</text>

            <rect x="506" y="229" width="173" height="62" rx="6" className="fill-blue-50 dark:fill-blue-950/40 stroke-blue-300 dark:stroke-blue-700" />
            <text x="592" y="252" textAnchor="middle" className="text-[11px] font-semibold fill-blue-900 dark:fill-blue-100">Resilience Selector</text>
            <text x="592" y="268" textAnchor="middle" className="text-[10px] font-mono fill-blue-700 dark:fill-blue-300">Selected vs Not-Selected</text>
            <text x="592" y="282" textAnchor="middle" className="text-[10px] font-mono fill-blue-700 dark:fill-blue-300">Path Score Ranking</text>

            {/* Arrow 3 -> 4 */}
            <line x1="695" y1="170" x2="735" y2="170" strokeWidth="2" markerEnd="url(#arch-arrow)" className="stroke-blue-600 dark:stroke-blue-400" />

            {/* Layer 4: Output & Evaluation */}
            <rect x="740" y="30" width="160" height="280" rx="8" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
            <text x="820" y="54" textAnchor="middle" className="text-[12px] font-semibold fill-slate-900 dark:fill-slate-100">
              4. Visual & Eval
            </text>
            <rect x="754" y="75" width="132" height="58" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="820" y="99" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">Column & Query</text>
            <text x="820" y="116" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">SVG DAG Graphs</text>

            <rect x="754" y="148" width="132" height="58" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="820" y="172" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">Result Table</text>
            <text x="820" y="189" textAnchor="middle" className="text-[10px] font-mono fill-amber-600 dark:fill-amber-400">Guessed Tag Overlay</text>

            <rect x="754" y="221" width="132" height="58" rx="6" className="fill-slate-100 dark:fill-slate-800 stroke-slate-300 dark:stroke-slate-700" />
            <text x="820" y="245" textAnchor="middle" className="text-[11px] font-semibold fill-slate-800 dark:fill-slate-200">Spider Benchmark</text>
            <text x="820" y="262" textAnchor="middle" className="text-[10px] font-mono fill-emerald-600 dark:fill-emerald-400">EX &amp; Component F1</text>
          </svg>
        </div>
      </section>

      {/* Section 3: Self-Healing & Path-Resilience State Machine Diagram */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          03. 5-Retry Self-Healing & Multi-Path Scoring Workflow
        </h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4">
          <svg
            viewBox="0 0 880 180"
            className="w-full min-w-[680px] h-auto"
            role="img"
            aria-label="5-Retry Self-Healing State Machine Diagram"
          >
            <defs>
              <marker
                id="heal-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" className="fill-slate-500 dark:fill-slate-400" />
              </marker>
            </defs>

            <rect x="16" y="46" width="150" height="64" rx="8" className="fill-white dark:fill-slate-900 stroke-blue-500" strokeWidth="1.5" />
            <text x="91" y="72" textAnchor="middle" className="text-[11px] font-semibold fill-slate-900 dark:fill-slate-100">Attempt 1: Generate</text>
            <text x="91" y="90" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">2-3 Path Candidates</text>

            <line x1="166" y1="78" x2="216" y2="78" strokeWidth="1.5" markerEnd="url(#heal-arrow)" className="stroke-slate-500 dark:stroke-slate-400" />

            <rect x="220" y="46" width="150" height="64" rx="8" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
            <text x="295" y="72" textAnchor="middle" className="text-[11px] font-semibold fill-slate-900 dark:fill-slate-100">Python SQLite Run</text>
            <text x="295" y="90" textAnchor="middle" className="text-[10px] font-mono fill-slate-500 dark:fill-slate-400">sqlite3 Read-Only URI</text>

            <line x1="370" y1="78" x2="420" y2="78" strokeWidth="1.5" markerEnd="url(#heal-arrow)" className="stroke-slate-500 dark:stroke-slate-400" />

            <rect x="424" y="46" width="160" height="64" rx="8" className="fill-rose-50 dark:fill-rose-950/30 stroke-rose-400 dark:stroke-rose-700" strokeWidth="1.5" />
            <text x="504" y="70" textAnchor="middle" className="text-[11px] font-semibold fill-rose-900 dark:fill-rose-100">Error? (Retry 1..5)</text>
            <text x="504" y="88" textAnchor="middle" className="text-[10px] font-mono fill-rose-700 dark:fill-rose-300">Feed Error + Schema</text>

            {/* Loop back arrow from Retry to Sandbox */}
            <path
              d="M 504 110 L 504 148 L 295 148 L 295 114"
              fill="none"
              strokeWidth="1.5"
              strokeDasharray="5 3"
              markerEnd="url(#heal-arrow)"
              className="stroke-amber-600 dark:stroke-amber-400"
            />
            <text x="400" y="164" textAnchor="middle" className="text-[10px] font-mono fill-amber-700 dark:fill-amber-300">
              Iterative Repair Loop (Up to 5 Additional Retries)
            </text>

            <line x1="584" y1="78" x2="644" y2="78" strokeWidth="1.5" markerEnd="url(#heal-arrow)" className="stroke-slate-500 dark:stroke-slate-400" />

            <rect x="648" y="46" width="212" height="64" rx="8" className="fill-emerald-50 dark:fill-emerald-950/30 stroke-emerald-500" strokeWidth="1.5" />
            <text x="754" y="70" textAnchor="middle" className="text-[11px] font-semibold fill-emerald-900 dark:fill-emerald-100">Score & Select Best Path</text>
            <text x="754" y="88" textAnchor="middle" className="text-[10px] font-mono fill-emerald-700 dark:fill-emerald-300">Highlight Used Cols & DAG</text>
          </svg>
        </div>
      </section>

      {/* Section 4: Step-by-Step Methodology */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          04. Step-by-Step Methodology
        </h2>
        <ol className="space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <li>
            <strong>Step 1 — Dual-Input Schema Acquisition:</strong> Accepts either pure natural language (Text-Only Mode, where your configured LLM infers a normalized relational DDL) or real <code className="font-mono text-xs">.sql</code> / <code className="font-mono text-xs">.db</code> SQLite files loaded into the Python 3.11 <code className="font-mono text-xs">sqlite3</code> backend with API credentials read from <code className="font-mono text-xs">.env</code>.
          </li>
          <li>
            <strong>Step 2 — Column-Level Graph & Edge Profiling:</strong> Introspects primary keys, explicit foreign keys, and inferred <code className="font-mono text-xs">*_id</code> references, mapping exact column-to-column edges and computing per-edge <code className="font-mono text-xs">orphanCount</code> and <code className="font-mono text-xs">missingRate</code>.
          </li>
          <li>
            <strong>Step 3 — Statistical Anomaly Detection & SQL Clearing:</strong> Flags IQR numeric outliers (<code className="font-mono text-xs">[Q1 - 1.5·IQR, Q3 + 1.5·IQR]</code>), negative domain violations, orphan FKs, and whitespace/casing fragmentation, allowing selective or batch SQL remediation with snapshot restore.
          </li>
          <li>
            <strong>Step 4 — Provenance-Tagged Cross-Column Imputation:</strong> Identifies <code className="font-mono text-xs">NULL</code>, empty, and sentinel strings (<code className="font-mono text-xs">N/A</code>, <code className="font-mono text-xs">unknown</code>) and fills them via conditional peer-group mean or mode, permanently attaching <code className="font-mono text-xs">GUESSED · WAS MISSING</code> provenance metadata.
          </li>
          <li>
            <strong>Step 5 — Multi-Path Candidate Generation & Resilience Ranking:</strong> Enumerates alternative join routes across the schema graph, executes each candidate query, computes <code className="font-mono text-xs">ResilienceScore</code>, and presents the Selected Best Query alongside all Not-Selected alternatives.
          </li>
          <li>
            <strong>Step 6 — 5-Retry Execution-Guided Self-Healing:</strong> Catches SQLite compilation/runtime failures and runs up to 5 iterative LLM repair passes using exact error messages and schema definitions.
          </li>
          <li>
            <strong>Step 7 — Official Spider Benchmark Validation:</strong> Evaluates user-specified <code className="font-mono text-xs">N</code> test cases from the official 1,034-task Yale Spider 1.0 Dev dataset stored locally across 166 SQLite databases using Execution Accuracy (EX) and Structural Component F1.
          </li>
        </ol>
      </section>

      {/* Section 5: Live Synchronized Results Summary */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          05. Live Synchronized Workspace & Benchmark Metrics
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
                <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Evaluation Dimension</th>
                <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Measured Value</th>
                <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Verification Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 font-mono tabular-nums">
              <tr>
                <td className="px-4 py-2.5 font-sans text-slate-800 dark:text-slate-200">Active Database Source</td>
                <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">{sourceName}</td>
                <td className="px-4 py-2.5 font-sans text-slate-500 dark:text-slate-400">Python sqlite3 Session</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-sans text-slate-800 dark:text-slate-200">Profiled Tables / Rows / Missing / Anomalies</td>
                <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">
                  {profile
                    ? `${profile.tables.length} tables · ${profile.totalRows} rows · ${profile.totalMissingCells} missing · ${profile.totalAnomalies} anomalies`
                    : 'Text-Only Mode'}
                </td>
                <td className="px-4 py-2.5 font-sans text-slate-500 dark:text-slate-400">Data Quality Profiler</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-sans text-slate-800 dark:text-slate-200">Last Query Multi-Path & Healing Trace</td>
                <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">
                  {lastQuery
                    ? `${lastQuery.candidates.length} candidates · ${lastQuery.totalAttempts}/6 attempts`
                    : 'Run a query in Query Studio'}
                </td>
                <td className="px-4 py-2.5 font-sans text-slate-500 dark:text-slate-400">AAMG-SQL Pipeline</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-sans text-slate-800 dark:text-slate-200">Spider Execution Accuracy (EX)</td>
                <td className="px-4 py-2.5 text-emerald-700 dark:text-emerald-300 font-semibold">
                  {benchmarkSummary
                    ? `${benchmarkSummary.executionAccuracy}% (${benchmarkSummary.results.filter((r) => r.executionMatch).length}/${benchmarkSummary.executedTasks})`
                    : 'Run Spider Benchmark tab to populate'}
                </td>
                <td className="px-4 py-2.5 font-sans text-slate-500 dark:text-slate-400">Official Spider 1.0 Dev</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-sans text-slate-800 dark:text-slate-200">Spider Component F1 / Avg Latency</td>
                <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">
                  {benchmarkSummary
                    ? `${benchmarkSummary.avgComponentF1}% F1 · ${benchmarkSummary.avgLatencyMs} ms`
                    : 'Pending Benchmark Run'}
                </td>
                <td className="px-4 py-2.5 font-sans text-slate-500 dark:text-slate-400">Spider Comparator</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
};
