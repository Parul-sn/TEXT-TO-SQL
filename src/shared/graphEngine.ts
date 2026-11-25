import type {
  ForeignKeyEdge,
  QueryCostBreakdown,
  QueryGraphEdge,
  QueryGraphNode,
  QueryGraphPlan,
  SchemaGraph,
  TableSchema,
} from './types.ts';

export interface JoinPathOption {
  tables: string[];
  edgeIds: string[];
  hopCount: number;
  anomalyPenalty: number;
  missingPenalty: number;
  resilienceScore: number;
  summary: string;
}

/**
 * Enumerates simple paths between two tables (or from a seed table across connected neighbors)
 * in the schema relationship graph and scores each path with the AAMG-SQL Path-Resilience formula.
 */
export function enumerateJoinPaths(
  graph: SchemaGraph,
  startTable: string,
  endTable?: string,
  maxHops = 4
): JoinPathOption[] {
  const adjacency = new Map<string, Array<{ nextTable: string; edge: ForeignKeyEdge }>>();
  for (const t of graph.tables) {
    adjacency.set(t.name, []);
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.fromTable)?.push({ nextTable: edge.toTable, edge });
    adjacency.get(edge.toTable)?.push({ nextTable: edge.fromTable, edge });
  }

  const paths: JoinPathOption[] = [];

  function dfs(
    current: string,
    visited: Set<string>,
    tableTrail: string[],
    edgeTrail: ForeignKeyEdge[]
  ) {
    if (endTable && current === endTable && edgeTrail.length > 0) {
      paths.push(scorePath(tableTrail, edgeTrail));
      return;
    }
    if (!endTable && edgeTrail.length >= 1) {
      paths.push(scorePath(tableTrail, edgeTrail));
    }
    if (edgeTrail.length >= maxHops) {
      return;
    }

    const neighbors = adjacency.get(current) ?? [];
    for (const { nextTable, edge } of neighbors) {
      if (visited.has(nextTable)) continue;
      visited.add(nextTable);
      dfs(nextTable, visited, [...tableTrail, nextTable], [...edgeTrail, edge]);
      visited.delete(nextTable);
    }
  }

  if (adjacency.has(startTable)) {
    const visited = new Set<string>([startTable]);
    dfs(startTable, visited, [startTable], []);
  }

  paths.sort((a, b) => b.resilienceScore - a.resilienceScore);
  return paths;
}

export function scorePath(
  tableTrail: string[],
  edgeTrail: ForeignKeyEdge[]
): JoinPathOption {
  const hopCount = edgeTrail.length;
  const anomalyPenalty = edgeTrail.reduce((acc, e) => acc + e.anomalyPenalty, 0);
  const missingPenalty = edgeTrail.reduce((acc, e) => acc + e.missingRate, 0);
  const inferredPenalty = edgeTrail.filter((e) => e.inferred).length * 0.08;

  // Higher score is better: parsimony rewards fewer hops, minus anomaly and missingness penalties
  const parsimony = 1 / (1 + 0.35 * Math.max(0, hopCount - 1));
  const rawScore =
    0.55 * parsimony +
    0.45 * Math.max(0, 1 - anomalyPenalty * 0.6 - missingPenalty * 0.5 - inferredPenalty);
  const resilienceScore = Math.round(Math.max(0.05, Math.min(0.99, rawScore)) * 1000) / 1000;

  return {
    tables: [...tableTrail],
    edgeIds: edgeTrail.map((e) => e.id),
    hopCount,
    anomalyPenalty: Math.round(anomalyPenalty * 1000) / 1000,
    missingPenalty: Math.round(missingPenalty * 1000) / 1000,
    resilienceScore,
    summary: tableTrail.join(' -> '),
  };
}

/**
 * Deterministic SQL-to-Relational-Query-Graph parser.
 * Extracts relational operators (SCAN, JOIN, FILTER, GROUP, AGGREGATE, SORT, LIMIT, PROJECT)
 * and maps referenced tables, columns, and foreign-key edges for Schema Graph highlighting.
 */
export function parseSqlToQueryGraph(
  sql: string,
  tables: TableSchema[],
  edges: ForeignKeyEdge[]
): QueryGraphPlan {
  const cleanSql = sql.replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').trim();
  const upper = cleanSql.toUpperCase();
  const tableMap = new Map<string, TableSchema>();
  for (const t of tables) {
    tableMap.set(t.name.toLowerCase(), t);
  }

  // Extract alias -> table mappings from FROM / JOIN clauses
  const aliasToTable = new Map<string, string>();
  const usedTablesSet = new Set<string>();

  const fromJoinRegex = /\b(?:FROM|JOIN)\s+["`[]?([a-zA-Z_][a-zA-Z0-9_]*)["`\]]?(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  const sqlKeywords = new Set([
    'WHERE', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS',
    'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'AS', 'SET', 'VALUES',
  ]);

  let match: RegExpExecArray | null;
  while ((match = fromJoinRegex.exec(cleanSql)) !== null) {
    const rawTable = match[1];
    const resolvedTable = tableMap.get(rawTable.toLowerCase())?.name ?? rawTable;
    usedTablesSet.add(resolvedTable);
    aliasToTable.set(resolvedTable.toLowerCase(), resolvedTable);
    if (match[2] && !sqlKeywords.has(match[2].toUpperCase())) {
      aliasToTable.set(match[2].toLowerCase(), resolvedTable);
    }
  }

  const usedTables = Array.from(usedTablesSet);
  const usedColumnsMap = new Map<string, { table: string; column: string }>();

  // Identify qualified columns like t.col
  const qualifiedColRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  while ((match = qualifiedColRegex.exec(cleanSql)) !== null) {
    const alias = match[1].toLowerCase();
    const col = match[2];
    const tableName = aliasToTable.get(alias);
    if (tableName) {
      const schemaTable = tableMap.get(tableName.toLowerCase());
      const matchedCol = schemaTable?.columns.find(
        (c) => c.name.toLowerCase() === col.toLowerCase()
      );
      const colName = matchedCol?.name ?? col;
      usedColumnsMap.set(`${tableName}.${colName}`, { table: tableName, column: colName });
    }
  }

  // Also identify unqualified column names belonging to used tables
  for (const tName of usedTables) {
    const schemaTable = tableMap.get(tName.toLowerCase());
    if (!schemaTable) continue;
    for (const col of schemaTable.columns) {
      const colWord = new RegExp(`\\b${escapeRegex(col.name)}\\b`, 'i');
      if (colWord.test(cleanSql)) {
        usedColumnsMap.set(`${tName}.${col.name}`, { table: tName, column: col.name });
      }
    }
  }

  // Match used edges between pairs of usedTables using explicit ON/WHERE join predicates
  const usedEdgeIds: string[] = [];
  for (const edge of edges) {
    if (!usedTablesSet.has(edge.fromTable) || !usedTablesSet.has(edge.toTable)) {
      continue;
    }

    const fromColPattern = escapeRegex(edge.fromColumn);
    const toColPattern = escapeRegex(edge.toColumn);
    const explicitJoinForward = new RegExp(
      `\\b[a-zA-Z_][a-zA-Z0-9_]*\\.${fromColPattern}\\s*=\\s*[a-zA-Z_][a-zA-Z0-9_]*\\.${toColPattern}\\b`,
      'i'
    );
    const explicitJoinReverse = new RegExp(
      `\\b[a-zA-Z_][a-zA-Z0-9_]*\\.${toColPattern}\\s*=\\s*[a-zA-Z_][a-zA-Z0-9_]*\\.${fromColPattern}\\b`,
      'i'
    );

    const hasFromCol = usedColumnsMap.has(`${edge.fromTable}.${edge.fromColumn}`);
    const hasToCol = usedColumnsMap.has(`${edge.toTable}.${edge.toColumn}`);
    const hasNaturalUsing = new RegExp(`\\bUSING\\s*\\(\\s*${fromColPattern}\\s*\\)`, 'i').test(cleanSql);

    if (
      explicitJoinForward.test(cleanSql) ||
      explicitJoinReverse.test(cleanSql) ||
      hasNaturalUsing ||
      (hasFromCol && hasToCol)
    ) {
      usedEdgeIds.push(edge.id);
    }
  }

  // Build Query Graph DAG nodes & edges
  const nodes: QueryGraphNode[] = [];
  const graphEdges: QueryGraphEdge[] = [];

  const scanIds: string[] = [];
  usedTables.forEach((tName, idx) => {
    const scanId = `scan_${idx}`;
    const tCols = Array.from(usedColumnsMap.values())
      .filter((c) => c.table === tName)
      .map((c) => c.column);
    const schemaTable = tableMap.get(tName.toLowerCase());
    nodes.push({
      id: scanId,
      operator: 'SCAN',
      label: `Scan ${tName}`,
      detail: schemaTable ? `${schemaTable.rowCount} rows` : 'Virtual relation',
      columns: tCols,
      estimatedRows: schemaTable?.rowCount,
    });
    scanIds.push(scanId);
  });

  if (scanIds.length === 0) {
    nodes.push({
      id: 'scan_0',
      operator: 'SCAN',
      label: 'Inferred Relation',
      detail: 'Text-only virtual table',
      columns: [],
    });
    scanIds.push('scan_0');
  }

  let currentTip = scanIds[0];

  // Add JOIN nodes if multiple tables
  if (scanIds.length > 1) {
    const onClauses = [
      ...cleanSql.matchAll(
        /\bON\s+(.+?)(?=\s+(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\b|\s+WHERE\b|\s+GROUP\s+BY\b|\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|;|$)/gi
      ),
    ].map((m) => m[1].trim());
    for (let i = 1; i < scanIds.length; i++) {
      const joinId = `join_${i}`;
      const isLeft = /\bLEFT\s+(?:OUTER\s+)?JOIN\b/i.test(cleanSql);
      nodes.push({
        id: joinId,
        operator: 'JOIN',
        label: isLeft ? 'Left Join' : 'Inner Join',
        detail: onClauses[i - 1] ? onClauses[i - 1].slice(0, 48) : 'Relational key match',
        columns: [],
      });
      graphEdges.push({ from: currentTip, to: joinId, label: 'left' });
      graphEdges.push({ from: scanIds[i], to: joinId, label: 'right' });
      currentTip = joinId;
    }
  }

  // Extract WHERE filter
  const whereMatch = cleanSql.match(
    /\bWHERE\s+(.+?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i
  );
  if (whereMatch) {
    const filterId = 'filter_0';
    nodes.push({
      id: filterId,
      operator: 'FILTER',
      label: 'Filter (WHERE)',
      detail: whereMatch[1].trim().slice(0, 56),
      columns: [],
    });
    graphEdges.push({ from: currentTip, to: filterId });
    currentTip = filterId;
  }

  // Extract GROUP BY / Aggregate
  const groupMatch = cleanSql.match(
    /\bGROUP\s+BY\s+(.+?)(?=\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i
  );
  const hasAgg = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(cleanSql);
  if (groupMatch || hasAgg) {
    const aggId = 'agg_0';
    nodes.push({
      id: aggId,
      operator: groupMatch ? 'GROUP' : 'AGGREGATE',
      label: groupMatch ? 'Group & Aggregate' : 'Aggregate',
      detail: groupMatch ? `BY ${groupMatch[1].trim().slice(0, 46)}` : 'Scalar aggregation',
      columns: [],
    });
    graphEdges.push({ from: currentTip, to: aggId });
    currentTip = aggId;
  }

  // Extract ORDER BY
  const orderMatch = cleanSql.match(/\bORDER\s+BY\s+(.+?)(?=\bLIMIT\b|;|$)/i);
  if (orderMatch) {
    const sortId = 'sort_0';
    nodes.push({
      id: sortId,
      operator: 'SORT',
      label: 'Sort (ORDER BY)',
      detail: orderMatch[1].trim().slice(0, 50),
      columns: [],
    });
    graphEdges.push({ from: currentTip, to: sortId });
    currentTip = sortId;
  }

  // Extract LIMIT
  const limitMatch = cleanSql.match(/\bLIMIT\s+(\d+)/i);
  if (limitMatch) {
    const limitId = 'limit_0';
    nodes.push({
      id: limitId,
      operator: 'LIMIT',
      label: `Limit (${limitMatch[1]})`,
      detail: `Top ${limitMatch[1]} rows`,
      columns: [],
    });
    graphEdges.push({ from: currentTip, to: limitId });
    currentTip = limitId;
  }

  // Final Projection
  const selectMatch = cleanSql.match(/\bSELECT\s+(?:DISTINCT\s+)?(.+?)(?=\bFROM\b|;|$)/i);
  const projCols = selectMatch
    ? selectMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6)
    : ['*'];
  const projId = 'project_0';
  nodes.push({
    id: projId,
    operator: 'PROJECT',
    label: upper.includes('SELECT DISTINCT') ? 'Distinct Project' : 'Project Output',
    detail: projCols.join(', ').slice(0, 56),
    columns: projCols,
  });
  graphEdges.push({ from: currentTip, to: projId });

  return {
    nodes,
    edges: graphEdges,
    usedTables,
    usedColumns: Array.from(usedColumnsMap.values()),
    usedEdgeIds,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function calculateQueryCost(params: {
  tables: TableSchema[];
  usedTables: string[];
  hopCount: number;
  anomalyPenalty: number;
  nullLossRate: number;
  semanticScore: number;
  executionMs: number;
  hasError: boolean;
  explainSteps?: string[];
}): QueryCostBreakdown {
  const steps = [...(params.explainSteps ?? [])];
  const rowLookup = new Map<string, number>();
  for (const t of params.tables) {
    rowLookup.set(t.name.toLowerCase(), Number(t.rowCount || 0));
  }

  const failureCost = params.hasError ? 10000 : 0;
  let planCost = 0;

  if (steps.length > 0) {
    for (const step of steps) {
      const up = step.toUpperCase();
      if (up.includes('SCAN ')) {
        const tblMatch = step.match(/\bSCAN\s+([a-zA-Z0-9_]+)/i);
        const tblRows = tblMatch ? rowLookup.get(tblMatch[1].toLowerCase()) ?? 10 : 10;
        planCost += Math.max(4, Math.log1p(Math.max(1, tblRows)) * 4.5);
      } else if (up.includes('SEARCH ')) {
        planCost += 1.5;
      }
      if (up.includes('TEMP B-TREE')) {
        planCost += 10;
      }
      if (
        up.includes('SUBQUERY') ||
        up.includes('CORRELATED') ||
        up.includes('CO-ROUTINE') ||
        up.includes('COMPOUND')
      ) {
        planCost += 8;
      }
    }
  } else {
    for (const tName of params.usedTables) {
      const tblRows = rowLookup.get(tName.toLowerCase()) ?? 10;
      planCost += Math.max(3.5, Math.log1p(Math.max(1, tblRows)) * 3.5);
    }
    if (params.usedTables.length === 0) {
      planCost = 4;
    }
  }

  const joinCost = params.hopCount * 9 + Math.max(0, params.usedTables.length - 1) * 3;
  const anomalyCost = params.anomalyPenalty * 65 + params.nullLossRate * 35;
  const semanticCost = Math.max(0, 1 - Math.max(0, Math.min(1, params.semanticScore))) * 40;
  const latencyCost = Math.min(50, Math.max(0, params.executionMs) * 0.5);

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const planCostR = r2(planCost);
  const joinCostR = r2(joinCost);
  const anomalyCostR = r2(anomalyCost);
  const semanticCostR = r2(semanticCost);
  const latencyCostR = r2(latencyCost);
  const failureCostR = r2(failureCost);
  const totalCost = r2(
    failureCostR + planCostR + joinCostR + anomalyCostR + semanticCostR + latencyCostR
  );

  return {
    planCost: planCostR,
    joinCost: joinCostR,
    anomalyCost: anomalyCostR,
    semanticCost: semanticCostR,
    latencyCost: latencyCostR,
    failureCost: failureCostR,
    totalCost,
    planSteps: steps,
  };
}
