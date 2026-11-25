import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  GitBranch,
  Key,
  Link2,
  Maximize2,
  Network,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  CandidatePathQuery,
  ForeignKeyEdge,
  QueryGraphPlan,
  TableSchema,
} from '../shared/types';

interface SchemaGraphCanvasProps {
  tables: TableSchema[];
  edges: ForeignKeyEdge[];
  queryGraph: QueryGraphPlan | null;
  candidates: CandidatePathQuery[];
  hoveredCandidateId: string | null;
  inferredDdl?: string;
}

interface NodePos {
  x: number;
  y: number;
}

const NODE_WIDTH = 274;
const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 26;

export const SchemaGraphCanvas: React.FC<SchemaGraphCanvasProps> = ({
  tables,
  edges,
  queryGraph,
  candidates,
  hoveredCandidateId,
}) => {
  const [activeGraphTab, setActiveGraphTab] = useState<'schema' | 'query'>('schema');
  const [zoom, setZoom] = useState(0.92);
  const [pan, setPan] = useState({ x: 16, y: 12 });
  const [positions, setPositions] = useState<Record<string, NodePos>>({});
  const [draggingTable, setDraggingTable] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; origX: number; origY: number } | null>(
    null
  );

  // Auto-layout tables in a clean grid/topological stagger whenever table list changes
  const defaultLayout = useMemo(() => {
    const map: Record<string, NodePos> = {};
    const cols = tables.length <= 2 ? 2 : 3;
    let maxRowHeights: number[] = [];

    tables.forEach((t, idx) => {
      const r = Math.floor(idx / cols);
      const h = HEADER_HEIGHT + t.columns.length * ROW_HEIGHT + 24;
      maxRowHeights[r] = Math.max(maxRowHeights[r] ?? 0, h);
    });

    const rowY: number[] = [16];
    for (let r = 1; r < maxRowHeights.length; r++) {
      rowY[r] = rowY[r - 1] + maxRowHeights[r - 1] + 34;
    }

    tables.forEach((t, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      const staggerY = c % 2 === 1 ? 18 : 0;
      map[t.name] = {
        x: 20 + c * (NODE_WIDTH + 88),
        y: (rowY[r] ?? 16) + staggerY,
      };
    });
    return map;
  }, [tables]);

  useEffect(() => {
    setPositions(defaultLayout);
  }, [defaultLayout]);

  const usedTablesSet = useMemo(
    () => new Set(queryGraph?.usedTables ?? []),
    [queryGraph]
  );
  const usedColsSet = useMemo(
    () =>
      new Set(
        (queryGraph?.usedColumns ?? []).map((c) => `${c.table}.${c.column}`)
      ),
    [queryGraph]
  );
  const usedEdgeIdsSet = useMemo(
    () => new Set(queryGraph?.usedEdgeIds ?? []),
    [queryGraph]
  );

  const hoveredCandidate = useMemo(
    () => candidates.find((c) => c.id === hoveredCandidateId && !c.selected) ?? null,
    [candidates, hoveredCandidateId]
  );
  const hoveredEdgeIdsSet = useMemo(
    () => new Set(hoveredCandidate?.graphPathEdges ?? []),
    [hoveredCandidate]
  );
  const hoveredColsSet = useMemo(
    () =>
      new Set(
        (hoveredCandidate?.usedColumns ?? []).map((c) => `${c.table}.${c.column}`)
      ),
    [hoveredCandidate]
  );

  const handleResetLayout = () => {
    setPositions(defaultLayout);
    setZoom(0.92);
    setPan({ x: 16, y: 12 });
  };

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (draggingTable) return;
    setIsPanning(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      origX: pan.x,
      origY: pan.y,
    };
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    if (draggingTable) {
      setPositions((prev) => ({
        ...prev,
        [draggingTable]: {
          x: dragStartRef.current!.origX + dx / zoom,
          y: dragStartRef.current!.origY + dy / zoom,
        },
      }));
    } else if (isPanning) {
      setPan({
        x: dragStartRef.current.origX + dx,
        y: dragStartRef.current.origY + dy,
      });
    }
  };

  const handleSvgMouseUp = () => {
    setDraggingTable(null);
    setIsPanning(false);
    dragStartRef.current = null;
  };

  const computeColumnPort = (
    tableName: string,
    columnName: string,
    side: 'left' | 'right'
  ): { x: number; y: number } | null => {
    const pos = positions[tableName] ?? defaultLayout[tableName];
    const table = tables.find((t) => t.name === tableName);
    if (!pos || !table) return null;
    const colIdx = table.columns.findIndex((c) => c.name === columnName);
    const effectiveIdx = colIdx >= 0 ? colIdx : 0;
    return {
      x: side === 'right' ? pos.x + NODE_WIDTH : pos.x,
      y: pos.y + HEADER_HEIGHT + effectiveIdx * ROW_HEIGHT + ROW_HEIGHT / 2,
    };
  };

  return (
    <section
      aria-label="Interactive Graph Visualizer"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/80">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setActiveGraphTab('schema')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeGraphTab === 'schema'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>Schema & Column Graph</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveGraphTab('query')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeGraphTab === 'query'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>Query Execution Graph</span>
          </button>
        </div>

        {/* Legend & Controls */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
          {activeGraphTab === 'schema' && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-blue-600 dark:bg-blue-400 inline-block" />
                <span>Selected Query Path</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t-2 border-dashed border-amber-500 inline-block" />
                <span>Alternative / Anomaly Edge</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-slate-400 dark:bg-slate-600 inline-block" />
                <span>Schema FK Link</span>
              </span>
            </div>
          )}

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.55, Math.round((z - 0.12) * 100) / 100))}
              aria-label="Zoom out graph"
              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-1.5 font-mono tabular-nums text-[11px] min-w-[44px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.12) * 100) / 100))}
              aria-label="Zoom in graph"
              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleResetLayout}
              aria-label="Reset graph layout"
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px]"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>
      </div>

      {/* Canvas Body */}
      {activeGraphTab === 'schema' ? (
        tables.length === 0 ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-center px-6 text-slate-500 dark:text-slate-400">
            <Maximize2 className="w-7 h-7 mb-2 opacity-60" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              No persistent database schema loaded
            </p>
            <p className="text-xs mt-1 max-w-md">
              In Text-Only Mode, run a natural-language prompt to generate an inferred DDL schema and switch to the Query Execution Graph tab to inspect the relational DAG.
            </p>
          </div>
        ) : (
          <div
            className="relative h-[500px] w-full bg-slate-50/80 dark:bg-slate-950/70 select-none overflow-hidden"
            data-testid="schema-graph-canvas"
          >
            {/* Subtle dot-grid backdrop */}
            <svg
              className="w-full h-full cursor-grab active:cursor-grabbing"
              onMouseDown={handleSvgMouseDown}
              onMouseMove={handleSvgMouseMove}
              onMouseUp={handleSvgMouseUp}
              onMouseLeave={handleSvgMouseUp}
            >
              <defs>
                <pattern
                  id="graphGrid"
                  width="20"
                  height="20"
                  patternUnits="userSpaceOnUse"
                >
                  <circle
                    cx="1"
                    cy="1"
                    r="1"
                    className="fill-slate-300/70 dark:fill-slate-800"
                  />
                </pattern>
                <marker
                  id="arrow-default"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" className="fill-slate-400 dark:fill-slate-500" />
                </marker>
                <marker
                  id="arrow-active"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" className="fill-blue-600 dark:fill-blue-400" />
                </marker>
                <marker
                  id="arrow-alt"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" className="fill-amber-500" />
                </marker>
              </defs>

              <rect width="100%" height="100%" fill="url(#graphGrid)" />

              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                {/* Column-to-Column Bezier Connectors */}
                {edges.map((edge, idx) => {
                  const fromPos = positions[edge.fromTable] ?? defaultLayout[edge.fromTable];
                  const toPos = positions[edge.toTable] ?? defaultLayout[edge.toTable];
                  if (!fromPos || !toPos) return null;

                  const fromLeftOfTo = fromPos.x + NODE_WIDTH < toPos.x;
                  const toLeftOfFrom = toPos.x + NODE_WIDTH < fromPos.x;

                  const startSide: 'left' | 'right' = fromLeftOfTo
                    ? 'right'
                    : toLeftOfFrom
                    ? 'left'
                    : 'right';
                  const endSide: 'left' | 'right' = fromLeftOfTo
                    ? 'left'
                    : toLeftOfFrom
                    ? 'right'
                    : 'right';

                  const p1 = computeColumnPort(edge.fromTable, edge.fromColumn, startSide);
                  const p2 = computeColumnPort(edge.toTable, edge.toColumn, endSide);
                  if (!p1 || !p2) return null;

                  const dx = Math.abs(p2.x - p1.x);
                  const offset = Math.max(48, dx * 0.45);
                  const c1x = startSide === 'right' ? p1.x + offset : p1.x - offset;
                  const c2x = endSide === 'right' ? p2.x + offset : p2.x - offset;
                  const pathD = `M ${p1.x} ${p1.y} C ${c1x} ${p1.y}, ${c2x} ${p2.y}, ${p2.x} ${p2.y}`;

                  const isUsed = usedEdgeIdsSet.has(edge.id);
                  const isHoveredAlt = hoveredEdgeIdsSet.has(edge.id);
                  const hasAnomaly = edge.orphanCount > 0 || edge.anomalyPenalty >= 0.35;

                  const strokeClass = isUsed
                    ? 'stroke-blue-600 dark:stroke-blue-400'
                    : isHoveredAlt || hasAnomaly
                    ? 'stroke-amber-500 dark:stroke-amber-400'
                    : 'stroke-slate-300 dark:stroke-slate-700';

                  const markerId = isUsed
                    ? 'url(#arrow-active)'
                    : isHoveredAlt || hasAnomaly
                    ? 'url(#arrow-alt)'
                    : 'url(#arrow-default)';

                  const midX = (p1.x + c1x + c2x + p2.x) / 4;
                  const midY = (p1.y + p2.y) / 2 + (idx % 2 === 0 ? -10 : 12);

                  return (
                    <g key={edge.id}>
                      <path
                        d={pathD}
                        fill="none"
                        strokeWidth={isUsed ? 2.75 : isHoveredAlt ? 2.25 : 1.5}
                        strokeDasharray={
                          !isUsed && (isHoveredAlt || edge.inferred || hasAnomaly)
                            ? '6 4'
                            : undefined
                        }
                        markerEnd={markerId}
                        className={`${strokeClass} transition-all`}
                      />
                      {/* Port dots directly on source and target columns */}
                      <circle
                        cx={p1.x}
                        cy={p1.y}
                        r={isUsed ? 4.5 : 3.5}
                        className={
                          isUsed
                            ? 'fill-blue-600 dark:fill-blue-400'
                            : hasAnomaly
                            ? 'fill-amber-500'
                            : 'fill-slate-400 dark:fill-slate-500'
                        }
                      />
                      <circle
                        cx={p2.x}
                        cy={p2.y}
                        r={isUsed ? 4.5 : 3.5}
                        className={
                          isUsed
                            ? 'fill-blue-600 dark:fill-blue-400'
                            : hasAnomaly
                            ? 'fill-amber-500'
                            : 'fill-slate-400 dark:fill-slate-500'
                        }
                      />

                      {/* Edge connection pill label */}
                      {(isUsed || isHoveredAlt || hasAnomaly) && (() => {
                        const labelText =
                          hasAnomaly && !isUsed
                            ? `${edge.fromColumn} (${edge.orphanCount} orphan)`
                            : `${edge.fromColumn} → ${edge.toColumn}`;
                        const boxW = Math.max(128, Math.round(labelText.length * 6.4 + 20));
                        return (
                          <g transform={`translate(${midX}, ${midY})`}>
                            <rect
                              x={-boxW / 2}
                              y={-10}
                              width={boxW}
                              height={20}
                              rx={4}
                              className={
                                isUsed
                                  ? 'fill-blue-50 dark:fill-blue-950/90 stroke-blue-300 dark:stroke-blue-700'
                                  : 'fill-amber-50 dark:fill-amber-950/90 stroke-amber-300 dark:stroke-amber-700'
                              }
                              strokeWidth={1}
                            />
                            <text
                              textAnchor="middle"
                              y={3.5}
                              className={`text-[9.5px] font-mono font-medium ${
                                isUsed
                                  ? 'fill-blue-700 dark:fill-blue-200'
                                  : 'fill-amber-800 dark:fill-amber-200'
                              }`}
                            >
                              {labelText}
                            </text>
                          </g>
                        );
                      })()}
                    </g>
                  );
                })}

                {/* Table Nodes with Column Rows */}
                {tables.map((table) => {
                  const pos = positions[table.name] ?? defaultLayout[table.name];
                  if (!pos) return null;
                  const nodeHeight = HEADER_HEIGHT + table.columns.length * ROW_HEIGHT + 8;
                  const isUsedTable = usedTablesSet.has(table.name);
                  const hasTableAnomalies = table.columns.some((c) => c.anomalyCount > 0);

                  return (
                    <g
                      key={table.name}
                      transform={`translate(${pos.x}, ${pos.y})`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setDraggingTable(table.name);
                        dragStartRef.current = {
                          x: e.clientX,
                          y: e.clientY,
                          origX: pos.x,
                          origY: pos.y,
                        };
                      }}
                      className="cursor-move"
                    >
                      {/* Card Shell */}
                      <rect
                        width={NODE_WIDTH}
                        height={nodeHeight}
                        rx={8}
                        className={`fill-white dark:fill-slate-900 ${
                          isUsedTable
                            ? 'stroke-blue-600 dark:stroke-blue-400'
                            : 'stroke-slate-300 dark:stroke-slate-700'
                        }`}
                        strokeWidth={isUsedTable ? 2 : 1}
                      />

                      {/* Table Header */}
                      <rect
                        width={NODE_WIDTH}
                        height={HEADER_HEIGHT}
                        rx={8}
                        className={
                          isUsedTable
                            ? 'fill-blue-50/90 dark:fill-blue-950/60'
                            : 'fill-slate-100/90 dark:fill-slate-800/80'
                        }
                      />
                      <line
                        x1={0}
                        y1={HEADER_HEIGHT}
                        x2={NODE_WIDTH}
                        y2={HEADER_HEIGHT}
                        className="stroke-slate-200 dark:stroke-slate-700"
                      />
                      <text
                        x={12}
                        y={24}
                        className={`text-[12.5px] font-semibold ${
                          isUsedTable
                            ? 'fill-blue-950 dark:fill-blue-100'
                            : 'fill-slate-900 dark:fill-slate-100'
                        }`}
                      >
                        {table.name}
                      </text>
                      <text
                        x={NODE_WIDTH - 12}
                        y={24}
                        textAnchor="end"
                        className="text-[10.5px] font-mono tabular-nums fill-slate-700 dark:fill-slate-300"
                      >
                        {table.rowCount} rows{hasTableAnomalies ? ' · !' : ''}
                      </text>

                      {/* Column Rows */}
                      {table.columns.map((col, cIdx) => {
                        const ry = HEADER_HEIGHT + cIdx * ROW_HEIGHT;
                        const isUsedCol = usedColsSet.has(`${table.name}.${col.name}`);
                        const isAltCol = hoveredColsSet.has(`${table.name}.${col.name}`);
                        const isAlertCol = col.missingCount > 0 || col.anomalyCount > 0;

                        return (
                          <g key={col.name} transform={`translate(0, ${ry})`}>
                            {(isUsedCol || isAltCol) && (
                              <rect
                                x={4}
                                y={2}
                                width={NODE_WIDTH - 8}
                                height={ROW_HEIGHT - 4}
                                rx={4}
                                className={
                                  isUsedCol
                                    ? 'fill-blue-100 dark:fill-blue-900/50'
                                    : 'fill-amber-100 dark:fill-amber-900/40'
                                }
                              />
                            )}
                            {/* Key marker */}
                            <text
                              x={12}
                              y={17}
                              className={`text-[9.5px] font-mono font-semibold ${
                                col.isPrimaryKey
                                  ? 'fill-amber-700 dark:fill-amber-400'
                                  : col.isForeignKey
                                  ? 'fill-blue-700 dark:fill-blue-400'
                                  : 'fill-slate-500 dark:fill-slate-400'
                              }`}
                            >
                              {col.isPrimaryKey ? 'PK' : col.isForeignKey ? 'FK' : '·'}
                            </text>
                            <text
                              x={32}
                              y={17}
                              className={`text-[11.5px] font-mono ${
                                isUsedCol
                                  ? 'fill-blue-950 dark:fill-blue-100 font-semibold'
                                  : 'fill-slate-900 dark:fill-slate-100'
                              }`}
                            >
                              {col.name.length > 18 ? col.name.slice(0, 17) + '…' : col.name}
                            </text>
                            <text
                              x={NODE_WIDTH - 12}
                              y={17}
                              textAnchor="end"
                              className={`text-[10px] font-mono ${
                                isAlertCol
                                  ? 'fill-amber-700 dark:fill-amber-300 font-semibold'
                                  : 'fill-slate-600 dark:fill-slate-300'
                              }`}
                            >
                              {isAlertCol
                                ? `${col.missingCount > 0 ? `${col.missingCount}m` : ''}${
                                    col.missingCount > 0 && col.anomalyCount > 0 ? ' · ' : ''
                                  }${col.anomalyCount > 0 ? `${col.anomalyCount}a` : ''}`
                                : col.type.slice(0, 7)}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        )
      ) : (
        /* Query Execution Graph (Relational Operator DAG) */
        <div
          className="h-[440px] w-full bg-slate-50/80 dark:bg-slate-950/70 overflow-auto p-6"
          data-testid="query-execution-graph"
        >
          {!queryGraph || queryGraph.nodes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 dark:text-slate-400">
              <GitBranch className="w-7 h-7 mb-2 opacity-60" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No Query Execution Plan Yet
              </p>
              <p className="text-xs mt-1">
                Generate or execute a SQL query to inspect its relational operator DAG.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                <span>
                  Relational Execution Pipeline ({queryGraph.nodes.length} operators ·{' '}
                  {queryGraph.usedTables.length} relation(s) ·{' '}
                  {queryGraph.usedColumns.length} bound column(s))
                </span>
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  Flow: Leaf Scans → Joins → Filters → Aggregation → Sort → Projection
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {queryGraph.nodes.map((node, idx) => {
                  const opColor =
                    node.operator === 'SCAN'
                      ? 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900'
                      : node.operator === 'JOIN'
                      ? 'border-blue-300 dark:border-blue-700 bg-blue-50/70 dark:bg-blue-950/40'
                      : node.operator === 'FILTER'
                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-950/40'
                      : node.operator === 'PROJECT'
                      ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/70 dark:bg-emerald-950/40'
                      : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900';

                  return (
                    <React.Fragment key={node.id}>
                      <div
                        className={`min-w-[200px] max-w-[260px] rounded-lg border p-3.5 ${opColor}`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[11px] font-mono font-semibold text-blue-700 dark:text-blue-300">
                            {node.operator}
                          </span>
                          {node.estimatedRows !== undefined && (
                            <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {node.estimatedRows} rows
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {node.label}
                        </div>
                        <div className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-1 break-words">
                          {node.detail}
                        </div>
                        {node.columns.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-200/80 dark:border-slate-800 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                            Cols: {node.columns.join(', ')}
                          </div>
                        )}
                      </div>
                      {idx < queryGraph.nodes.length - 1 && (
                        <span
                          aria-hidden="true"
                          className="text-slate-400 dark:text-slate-600 font-mono text-sm"
                        >
                          →
                        </span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Used Columns & Edges Summary */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div>
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Columns Referenced in Query</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-slate-600 dark:text-slate-400">
                    {queryGraph.usedColumns.length > 0 ? (
                      queryGraph.usedColumns.map((c) => (
                        <span key={`${c.table}.${c.column}`}>
                          {c.table}.{c.column}
                        </span>
                      ))
                    ) : (
                      <span>All / Inferred projection</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Foreign-Key Join Edges Traversed</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-slate-600 dark:text-slate-400">
                    {queryGraph.usedEdgeIds.length > 0 ? (
                      edges
                        .filter((e) => queryGraph.usedEdgeIds.includes(e.id))
                        .map((e) => (
                          <span key={e.id} className="inline-flex items-center gap-1">
                            {e.fromTable}.{e.fromColumn} → {e.toTable}.{e.toColumn}
                            {e.orphanCount > 0 && (
                              <AlertTriangle className="w-3 h-3 text-amber-500" />
                            )}
                          </span>
                        ))
                    ) : (
                      <span>Single-table scan (no multi-table join edges)</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
