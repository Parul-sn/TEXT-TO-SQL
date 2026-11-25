import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Database,
  Download,
  Play,
  RefreshCw,
  Search,
  Square,
  XCircle,
} from 'lucide-react';
import type {
  SpiderBenchmarkSummary,
  SpiderDatasetInfo,
  SpiderHardness,
  SpiderJobStatus,
  SpiderTask,
} from '../shared/types';

interface SpiderBenchmarkViewProps {
  benchmarkSummary: SpiderBenchmarkSummary | null;
  onBenchmarkComplete: (summary: SpiderBenchmarkSummary) => void;
}

interface PaginatedTasksResponse {
  tasks: SpiderTask[];
  totalAvailable: number;
  filteredTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function getVisiblePageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: Array<number | 'ellipsis'> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) pages.push('ellipsis');
  for (let p = left; p <= right; p++) {
    pages.push(p);
  }
  if (right < total - 1) pages.push('ellipsis');
  pages.push(total);
  return pages;
}

export const SpiderBenchmarkView: React.FC<SpiderBenchmarkViewProps> = ({
  benchmarkSummary,
  onBenchmarkComplete,
}) => {
  const [datasetInfo, setDatasetInfo] = useState<SpiderDatasetInfo | null>(null);
  const [hardnessFilter, setHardnessFilter] = useState<'All' | SpiderHardness>('All');
  const [testCountInput, setTestCountInput] = useState<string>('5');
  const [startOffsetInput, setStartOffsetInput] = useState<string>('0');

  // Pagination & search state across all 1,034 Spider tasks
  const [listMode, setListMode] = useState<'browse' | 'evaluated'>('browse');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [pagedTasks, setPagedTasks] = useState<SpiderTask[]>([]);
  const [filteredTotal, setFilteredTotal] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [isLoadingTasks, setIsLoadingTasks] = useState<boolean>(false);

  const [jobStatus, setJobStatus] = useState<SpiderJobStatus | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setCurrentPage(1);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadInfoAndStatus = useCallback(async () => {
    try {
      const [infoRes, statusRes] = await Promise.all([
        fetch('/api/spider/info'),
        fetch('/api/spider/status'),
      ]);
      const infoData = (await infoRes.json()) as SpiderDatasetInfo;
      const statusData = (await statusRes.json()) as SpiderJobStatus;
      setDatasetInfo(infoData);
      setJobStatus(statusData);
      if (statusData.summary && statusData.summary.executedTasks > 0) {
        onBenchmarkComplete(statusData.summary);
        setListMode('evaluated');
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to load official Spider dataset metadata.'
      );
    }
  }, [onBenchmarkComplete]);

  useEffect(() => {
    loadInfoAndStatus();
  }, [loadInfoAndStatus]);

  const loadPagedTasks = useCallback(async () => {
    setIsLoadingTasks(true);
    try {
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
        hardness: hardnessFilter,
      });
      if (debouncedSearch) {
        params.set('search', debouncedSearch);
      }
      const res = await fetch(`/api/spider/tasks?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load Spider task page.');
      const data = (await res.json()) as PaginatedTasksResponse;
      setPagedTasks(data.tasks ?? []);
      setFilteredTotal(data.filteredTotal ?? data.totalAvailable ?? 0);
      setTotalPages(Math.max(1, data.totalPages ?? 1));
      if (data.page && data.page !== currentPage) {
        setCurrentPage(data.page);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load paginated Spider tasks.');
    } finally {
      setIsLoadingTasks(false);
    }
  }, [currentPage, pageSize, hardnessFilter, debouncedSearch]);

  useEffect(() => {
    loadPagedTasks();
  }, [loadPagedTasks]);

  // Poll live job progress while running
  useEffect(() => {
    if (jobStatus?.status !== 'running') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch('/api/spider/status');
        const statusData = (await res.json()) as SpiderJobStatus;
        setJobStatus(statusData);
        if (statusData.summary && statusData.summary.executedTasks > 0) {
          onBenchmarkComplete(statusData.summary);
        }
        if (statusData.status === 'error' && statusData.error) {
          setErrorMsg(statusData.error);
        }
      } catch {
        // retry on next interval
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [jobStatus?.status, onBenchmarkComplete]);

  const maxAvailableForFilter = datasetInfo
    ? hardnessFilter === 'All'
      ? datasetInfo.totalTasks
      : datasetInfo.hardnessCounts[hardnessFilter] ?? 0
    : 1034;

  const startBenchmarkJob = async (
    override?: { count?: number; offset?: number; taskIds?: string[] }
  ) => {
    setErrorMsg(null);
    const parsedCount = Math.max(
      1,
      Math.min(maxAvailableForFilter || 1034, Number(testCountInput) || 5)
    );
    const parsedOffset = Math.max(0, Number(startOffsetInput) || 0);

    try {
      const res = await fetch('/api/spider/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          override?.taskIds
            ? { taskIds: override.taskIds }
            : {
                count: override?.count ?? parsedCount,
                offset: override?.offset ?? parsedOffset,
                hardness: hardnessFilter,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start Spider benchmark job.');
      }
      setJobStatus(data as SpiderJobStatus);
      setListMode('evaluated');
      setCurrentPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelJob = async () => {
    try {
      const res = await fetch('/api/spider/cancel', { method: 'POST' });
      const data = (await res.json()) as SpiderJobStatus;
      setJobStatus(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadDataset = async () => {
    setIsDownloading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/spider/download', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Official Spider download failed.');
      setDatasetInfo(data as SpiderDatasetInfo);
      await loadPagedTasks();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDownloading(false);
    }
  };

  const handleHardnessChange = (lvl: 'All' | SpiderHardness) => {
    setHardnessFilter(lvl);
    setCurrentPage(1);
  };

  const isRunning = jobStatus?.status === 'running';
  const completedCount = jobStatus?.completed ?? 0;
  const targetTotal = jobStatus?.total ?? 0;
  const progressPct = targetTotal > 0 ? Math.round((completedCount / targetTotal) * 100) : 0;

  const executedResults = benchmarkSummary?.results ?? [];
  const resultByTaskId = new Map(executedResults.map((r) => [r.taskId, r]));

  const filteredEvaluated = executedResults.filter((r) => {
    if (hardnessFilter !== 'All' && r.hardness !== hardnessFilter) return false;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      return (
        r.question.toLowerCase().includes(q) ||
        r.dbId.toLowerCase().includes(q) ||
        r.taskId.toLowerCase().includes(q) ||
        r.goldSql.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const showingEvaluated = listMode === 'evaluated' && executedResults.length > 0;
  const evalTotalPages = Math.max(1, Math.ceil(filteredEvaluated.length / pageSize));
  const activeTotalPages = showingEvaluated ? evalTotalPages : totalPages;
  const safePage = Math.min(currentPage, activeTotalPages);
  const activeTotalItems = showingEvaluated ? filteredEvaluated.length : filteredTotal;
  const rangeStart = activeTotalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(activeTotalItems, safePage * pageSize);

  const visibleItems = showingEvaluated
    ? filteredEvaluated.slice((safePage - 1) * pageSize, safePage * pageSize).map((r) => ({
        id: r.taskId,
        dbId: r.dbId,
        dbName: r.dbId,
        hardness: r.hardness,
        question: r.question,
        goldSql: r.goldSql,
        res: r,
      }))
    : pagedTasks.map((t) => ({
        ...t,
        res: resultByTaskId.get(t.id),
      }));

  const pageNumbers = getVisiblePageNumbers(safePage, activeTotalPages);

  const renderPaginationBar = (position: 'top' | 'bottom') => (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-slate-50/70 dark:bg-slate-950/40 ${
        position === 'top'
          ? 'border-b border-slate-200 dark:border-slate-800'
          : 'border-t border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
        <span className="font-mono tabular-nums">
          Showing <strong className="text-slate-900 dark:text-slate-100">{rangeStart}</strong>–
          <strong className="text-slate-900 dark:text-slate-100">{rangeEnd}</strong> of{' '}
          <strong className="text-slate-900 dark:text-slate-100">
            {activeTotalItems.toLocaleString()}
          </strong>{' '}
          {hardnessFilter === 'All' ? '' : `${hardnessFilter} `}tasks · Page{' '}
          <strong className="text-slate-900 dark:text-slate-100">{safePage}</strong> of{' '}
          <strong className="text-slate-900 dark:text-slate-100">{activeTotalPages}</strong>
        </span>

        {!showingEvaluated && visibleItems.length > 0 && (
          <button
            type="button"
            disabled={isRunning}
            onClick={() => startBenchmarkJob({ taskIds: visibleItems.map((i) => i.id) })}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 text-[11px] font-medium text-blue-700 dark:text-blue-300"
          >
            <Play className="w-3 h-3" />
            <span>Run This Page ({visibleItems.length})</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <span>Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setCurrentPage(1);
            }}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {[10, 25, 50, 100].map((sz) => (
              <option key={sz} value={sz}>
                {sz}
              </option>
            ))}
          </select>
        </label>

        <nav aria-label={`Spider pagination (${position})`} className="flex items-center gap-1">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => setCurrentPage(1)}
            title="First page"
            aria-label="First page"
            className="p-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <ChevronsLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => setCurrentPage(Math.max(1, safePage - 1))}
            title="Previous page"
            aria-label="Previous page"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Prev</span>
          </button>

          {pageNumbers.map((p, idx) =>
            p === 'ellipsis' ? (
              <span
                key={`el-${idx}`}
                className="px-1.5 text-xs font-mono text-slate-400 select-none"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => setCurrentPage(p)}
                className={`min-w-[28px] px-2 py-1 rounded-md text-xs font-mono tabular-nums border transition-colors ${
                  p === safePage
                    ? 'border-blue-600 bg-blue-600 text-white font-semibold'
                    : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {p}
              </button>
            )
          )}

          <button
            type="button"
            disabled={safePage >= activeTotalPages}
            onClick={() => setCurrentPage(Math.min(activeTotalPages, safePage + 1))}
            title="Next page"
            aria-label="Next page"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <span>Next</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={safePage >= activeTotalPages}
            onClick={() => setCurrentPage(activeTotalPages)}
            title="Last page"
            aria-label="Last page"
            className="p-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <ChevronsRight className="w-3.5 h-3.5" />
          </button>
        </nav>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Dataset Status & N-Task Runner Card */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-blue-600 dark:text-blue-400">
              <Database className="w-3.5 h-3.5" />
              <span>
                {datasetInfo?.downloaded
                  ? `${datasetInfo.datasetName} · ${datasetInfo.totalTasks.toLocaleString()} Tasks · ${datasetInfo.totalDatabases} SQLite Databases`
                  : 'Official Spider Dataset Not Yet Downloaded'}
              </span>
              {datasetInfo?.datasetDir && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-500 dark:text-slate-400">{datasetInfo.datasetDir}</span>
                </>
              )}
            </div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Official Spider Benchmark Runner
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Evaluates our Text-to-SQL + 5-Retry Self-Healing pipeline directly against the official Yale Spider 1.0 SQLite databases saved locally in this program. Choose how many test cases to run below, or browse all{' '}
              {(datasetInfo?.totalTasks ?? 1034).toLocaleString()} tasks page by page.
            </p>
          </div>

          <button
            type="button"
            disabled={isDownloading || isRunning}
            onClick={handleDownloadDataset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap"
          >
            {isDownloading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>
              {isDownloading
                ? 'Downloading Official Spider...'
                : datasetInfo?.downloaded
                ? 'Re-Sync Official Dataset'
                : 'Download Official Spider'}
            </span>
          </button>
        </div>

        {/* Interactive Test Count Prompt & Controls */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startBenchmarkJob();
          }}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-4 space-y-1.5">
              <label
                htmlFor="spider-test-count"
                className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
              >
                How many test cases to run? (1 – {maxAvailableForFilter})
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="spider-test-count"
                  type="number"
                  min={1}
                  max={maxAvailableForFilter || 1034}
                  value={testCountInput}
                  onChange={(e) => setTestCountInput(e.target.value)}
                  disabled={isRunning}
                  className="w-28 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex flex-wrap gap-1">
                  {[5, 10, 25, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={isRunning || preset > maxAvailableForFilter}
                      onClick={() => setTestCountInput(String(preset))}
                      className={`px-2 py-1.5 rounded-md text-xs font-mono tabular-nums border transition-colors ${
                        Number(testCountInput) === preset
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold'
                          : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={isRunning || maxAvailableForFilter === 0}
                    onClick={() => setTestCountInput(String(maxAvailableForFilter))}
                    className={`px-2 py-1.5 rounded-md text-xs font-mono tabular-nums border transition-colors ${
                      Number(testCountInput) === maxAvailableForFilter
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    All ({maxAvailableForFilter})
                  </button>
                </div>
              </div>
            </div>

            <div className="md:col-span-2 space-y-1.5">
              <label
                htmlFor="spider-offset"
                className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
              >
                Start Offset
              </label>
              <input
                id="spider-offset"
                type="number"
                min={0}
                max={Math.max(0, maxAvailableForFilter - 1)}
                value={startOffsetInput}
                onChange={(e) => setStartOffsetInput(e.target.value)}
                disabled={isRunning}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="md:col-span-3 space-y-1.5">
              <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                Hardness Filter
              </span>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 overflow-x-auto">
                {(['All', 'Easy', 'Medium', 'Hard', 'Extra Hard'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    disabled={isRunning}
                    onClick={() => handleHardnessChange(lvl)}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                      hardnessFilter === lvl
                        ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div className="md:col-span-3 flex items-center justify-end gap-2">
              {isRunning ? (
                <button
                  type="button"
                  onClick={handleCancelJob}
                  className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Cancel Benchmark ({completedCount}/{targetTotal})</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!datasetInfo?.downloaded}
                  className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Start {Math.max(1, Number(testCountInput) || 5)}-Test Benchmark</span>
                </button>
              )}
            </div>
          </div>

          {/* Live Job Progress */}
          {jobStatus && jobStatus.status !== 'idle' && (
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
                <span>
                  Status:{' '}
                  <strong className="uppercase">{jobStatus.status}</strong> · Executed{' '}
                  {completedCount} / {targetTotal} tests
                  {jobStatus.configuredKeys ? (
                    <>
                      {' · '}Active Key #{jobStatus.activeKeySlot ?? 1}/{jobStatus.configuredKeys}
                    </>
                  ) : null}
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    jobStatus.status === 'error'
                      ? 'bg-rose-600'
                      : jobStatus.status === 'completed'
                      ? 'bg-emerald-600 dark:bg-emerald-400'
                      : 'bg-blue-600 dark:bg-blue-400'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              {jobStatus.failoverEvents && jobStatus.failoverEvents.length > 0 && (
                <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 text-[11px] font-mono text-amber-900 dark:text-amber-200 space-y-0.5">
                  <div className="font-sans font-semibold text-xs">API Key Failover Log</div>
                  {jobStatus.failoverEvents.map((ev, i) => (
                    <div key={i}>{ev}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </form>

        {errorMsg && (
          <div
            role="alert"
            className="p-3 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-xs text-rose-800 dark:text-rose-200 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
      </section>

      {/* Live Benchmark KPI Strip */}
      {benchmarkSummary && benchmarkSummary.executedTasks > 0 && (
        <section className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Execution Accuracy (EX)</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
                {benchmarkSummary.executionAccuracy}%
              </div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                {benchmarkSummary.results.filter((r) => r.executionMatch).length}/
                {benchmarkSummary.executedTasks} matched
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">First-Pass Accuracy</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                {benchmarkSummary.firstPassAccuracy}%
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Self-Healed Gain</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-blue-600 dark:text-blue-400 mt-1">
                +{benchmarkSummary.healedAccuracy}%
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Avg Component F1</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                {benchmarkSummary.avgComponentF1}%
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Avg Pipeline Latency</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                {benchmarkSummary.avgLatencyMs} ms
              </div>
            </div>
          </div>

          {/* Accuracy by Spider Hardness */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
              Execution Accuracy by Official Spider Hardness Level
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              {(['Easy', 'Medium', 'Hard', 'Extra Hard'] as SpiderHardness[]).map((lvl) => {
                const stats = benchmarkSummary.byHardness[lvl];
                const totalInSplit = datasetInfo?.hardnessCounts?.[lvl] ?? 0;
                return (
                  <div key={lvl} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {lvl} <span className="text-slate-400 font-mono">({totalInSplit})</span>
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {stats.passed}/{stats.total} ({stats.accuracy}%)
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-600 dark:bg-blue-400 rounded-full transition-all"
                        style={{ width: `${stats.accuracy}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Paginated All-Dataset Task Browser & Executed Results Table */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {showingEvaluated
                ? `Evaluated Spider Test Cases (${filteredEvaluated.length})`
                : `Official Spider Dev Tasks (${filteredTotal.toLocaleString()} ${
                    hardnessFilter === 'All' ? 'Total' : hardnessFilter
                  })`}
            </h2>

            {executedResults.length > 0 && (
              <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setListMode('browse');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    listMode === 'browse'
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  All Tasks ({(datasetInfo?.totalTasks ?? 1034).toLocaleString()})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setListMode('evaluated');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    listMode === 'evaluated'
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Evaluated ({executedResults.length})
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search question, DB, ID, SQL..."
                className="w-56 sm:w-64 pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {renderPaginationBar('top')}

        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {isLoadingTasks && !showingEvaluated && visibleItems.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              Loading Spider benchmark tasks...
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              No Spider tasks match the current filter or search query.
            </div>
          ) : (
            visibleItems.map((item) => {
              const res = item.res;
              return (
                <div key={item.id} className="p-4 space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-[260px]">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                          {item.id.toUpperCase()}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{item.dbId}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.hardness}</span>
                        {res && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span
                              className={`inline-flex items-center gap-1 font-semibold ${
                                res.executionMatch
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {res.executionMatch ? (
                                <>
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>Execution Match Passed</span>
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-3.5 h-3.5" />
                                  <span>Mismatch / Failed</span>
                                </>
                              )}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              F1 {Math.round(res.componentMatchF1 * 100)}% · Attempts {res.attemptsUsed}
                              {res.queryCost !== undefined ? ` · Cost ${res.queryCost}` : ''}
                              {res.keySlot !== undefined ? ` · Key #${res.keySlot}` : ''} ·{' '}
                              {res.executionMs} ms
                            </span>
                          </>
                        )}
                      </div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {item.question}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => startBenchmarkJob({ taskIds: [item.id] })}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0"
                    >
                      <Play className="w-3 h-3" />
                      <span>Run Task</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                        Gold SQL
                      </div>
                      <pre className="p-2.5 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto whitespace-pre-wrap">
                        {item.goldSql}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                        Predicted SQL {res?.healedOnRetry ? '(Self-Healed)' : ''}
                      </div>
                      <pre className="p-2.5 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto whitespace-pre-wrap">
                        {res
                          ? res.predictedSql || res.error || 'No SQL returned'
                          : 'Set test count above and click Start Benchmark, or click Run Task.'}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {activeTotalItems > 0 && renderPaginationBar('bottom')}
      </section>
    </div>
  );
};
