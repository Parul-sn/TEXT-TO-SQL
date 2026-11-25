import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Moon, Sun, Upload } from 'lucide-react';
import { DataQualityView } from './components/DataQualityView';
import { ProjectReportView } from './components/ProjectReportView';
import { QueryStudioView } from './components/QueryStudioView';
import { SpiderBenchmarkView } from './components/SpiderBenchmarkView';
import type {
  DataProfile,
  ShowcaseExample,
  SpiderBenchmarkSummary,
  TextToSqlResponse,
} from './shared/types';

type ActiveTab = 'studio' | 'quality' | 'spider' | 'report';

export default function App() {
  const [sessionId] = useState(() => `sess_${Math.random().toString(36).slice(2, 10)}`);
  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');

  const [examples, setExamples] = useState<ShowcaseExample[]>([]);
  const [mode, setMode] = useState<'database' | 'text_only'>('database');
  const [sourceName, setSourceName] = useState('E-Commerce Multi-Path & Anomalies');
  const [exampleId, setExampleId] = useState<string | undefined>('ecommerce_multipath');
  const [profile, setProfile] = useState<DataProfile | null>(null);

  const [question, setQuestion] = useState(
    'Show total verified order amount and order count per customer name and region'
  );
  const [sqlResult, setSqlResult] = useState<TextToSqlResponse | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const [benchmarkSummary, setBenchmarkSummary] =
    useState<SpiderBenchmarkSummary | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  }, [isDark]);

  const fetchInitialData = useCallback(async () => {
    try {
      const [exRes, stateRes] = await Promise.all([
        fetch('/api/examples'),
        fetch('/api/db/state', { headers: { 'x-session-id': sessionId } }),
      ]);
      const exData = await exRes.json();
      const stateData = await stateRes.json();
      if (Array.isArray(exData.examples)) {
        setExamples(exData.examples);
      }
      if (stateData && !stateData.error) {
        setMode(stateData.mode);
        setSourceName(stateData.sourceName);
        setExampleId(stateData.exampleId);
        setProfile(stateData.profile ?? null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect to workspace server.');
    }
  }, [sessionId]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  const handleSelectExample = async (id: string) => {
    setErrorMsg(null);
    setUploadNotice(null);
    setSqlResult(null);
    const chosen = examples.find((e) => e.id === id);
    if (chosen && chosen.sampleQuestions.length > 0) {
      setQuestion(chosen.sampleQuestions[0]);
    }
    try {
      const res = await fetch('/api/db/load-example', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ exampleId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load example.');
      setMode(data.mode);
      setSourceName(data.sourceName);
      setExampleId(data.exampleId);
      setProfile(data.profile ?? null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setUploadNotice(null);
    setSqlResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/db/upload', {
        method: 'POST',
        headers: { 'x-session-id': sessionId },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse uploaded file.');
      setMode(data.mode);
      setSourceName(data.sourceName);
      setExampleId(undefined);
      setProfile(data.profile ?? null);
      setUploadNotice(`Loaded ${file.name} (${data.profile?.tables?.length ?? 0} tables profiled).`);
      setActiveTab('studio');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGenerateSql = async (
    questionOverride?: string,
    forceTextOnly?: boolean
  ) => {
    const activeQ = (questionOverride ?? question).trim();
    if (!activeQ) return;
    setIsGenerating(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/sql/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({
          question: activeQ,
          forceTextOnly: forceTextOnly ?? mode === 'text_only',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SQL generation failed.');
      setSqlResult(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExecuteManualSql = async (manualSql: string) => {
    setErrorMsg(null);
    try {
      const res = await fetch('/api/sql/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ sql: manualSql }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SQL execution failed.');
      if (sqlResult) {
        setSqlResult({
          ...sqlResult,
          selectedSql: manualSql,
          queryGraph: data.queryGraph,
          result: data.execution,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCleanAnomaly = async (
    anomalyId: string,
    actionType?: string,
    customInstruction?: string
  ): Promise<{ ok: boolean; message?: string; appliedSql?: string; error?: string }> => {
    setErrorMsg(null);
    const res = await fetch('/api/db/clean-anomaly', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({
        anomalyId,
        actionType,
        customInstruction,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error || 'Failed to clean anomaly.';
      setErrorMsg(msg);
      return { ok: false, error: msg };
    }
    setProfile(data.profile ?? null);
    return {
      ok: true,
      message: data.message || data.actionSummary,
      appliedSql: data.appliedSql,
    };
  };

  const handleCleanCustomColumn = async (
    tableName: string,
    columnName: string,
    instruction: string
  ): Promise<{ ok: boolean; message?: string; appliedSql?: string; error?: string }> => {
    setErrorMsg(null);
    const res = await fetch('/api/db/clean-custom', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({ tableName, columnName, instruction }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error || 'Failed to apply general-language rule.';
      setErrorMsg(msg);
      return { ok: false, error: msg };
    }
    setProfile(data.profile ?? null);
    return {
      ok: true,
      message: data.message || data.actionSummary,
      appliedSql: data.appliedSql,
    };
  };

  const handleCleanAllAnomalies = async () => {
    setErrorMsg(null);
    const res = await fetch('/api/db/clean-all', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error || 'Failed to clean anomalies.');
      return;
    }
    setProfile(data.profile ?? null);
  };

  const handleResetDatabase = async () => {
    setErrorMsg(null);
    const res = await fetch('/api/db/reset', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error || 'Failed to reset database.');
      return;
    }
    setProfile(data.profile ?? null);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* Top Bar Contract: Zone 1 (Wordmark) — Zone 2 (4 Nav Links) — Zone 3 (Theme + Primary CTA) */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs no-print">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('studio');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
          >
            GraphSQL Studio
          </a>

          {/* Zone 2: 4 concise single-line text nav links */}
          <nav
            aria-label="Primary Workspace Navigation"
            className="flex items-center gap-6 overflow-x-auto text-sm font-medium"
          >
            {(
              [
                { id: 'studio', label: 'Query Studio' },
                { id: 'quality', label: 'Data & Anomalies' },
                { id: 'spider', label: 'Spider Benchmark' },
                { id: 'report', label: 'Project Report' },
              ] as const
            ).map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-blue-600 dark:border-blue-400 text-slate-900 dark:text-slate-100 font-semibold'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Theme Switch & File Upload Primary Action */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsDark((d) => !d)}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center justify-center p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3,.sql"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="Upload SQLite .db or .sql file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload .db / .sql</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6">
        {uploadNotice && (
          <div className="mb-4 px-4 py-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200 flex items-center justify-between">
            <span>{uploadNotice}</span>
            <button
              type="button"
              onClick={() => setUploadNotice(null)}
              className="underline text-xs"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'studio' && (
          <QueryStudioView
            mode={mode}
            sourceName={sourceName}
            exampleId={exampleId}
            examples={examples}
            profile={profile}
            question={question}
            onQuestionChange={setQuestion}
            onGenerateSql={handleGenerateSql}
            onExecuteManualSql={handleExecuteManualSql}
            onSelectExample={handleSelectExample}
            onSwitchToDataQuality={() => setActiveTab('quality')}
            sqlResult={sqlResult}
            isGenerating={isGenerating}
            errorMsg={errorMsg}
          />
        )}

        {activeTab === 'quality' && (
          <DataQualityView
            profile={profile}
            mode={mode}
            onCleanAnomaly={handleCleanAnomaly}
            onCleanCustomColumn={handleCleanCustomColumn}
            onCleanAllAnomalies={handleCleanAllAnomalies}
            onResetDatabase={handleResetDatabase}
            onLoadExample={handleSelectExample}
            sessionId={sessionId}
          />
        )}

        {activeTab === 'spider' && (
          <SpiderBenchmarkView
            benchmarkSummary={benchmarkSummary}
            onBenchmarkComplete={setBenchmarkSummary}
          />
        )}

        {activeTab === 'report' && (
          <ProjectReportView
            profile={profile}
            lastQuery={sqlResult}
            benchmarkSummary={benchmarkSummary}
            sourceName={sourceName}
          />
        )}
      </main>
    </div>
  );
}
