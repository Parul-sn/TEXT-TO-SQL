export interface ColumnSchema {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencesTable?: string;
  referencesColumn?: string;
  nullable: boolean;
  missingCount: number;
  missingRate: number;
  anomalyCount: number;
}

export interface TableSchema {
  name: string;
  rowCount: number;
  columns: ColumnSchema[];
}

export interface ForeignKeyEdge {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  inferred: boolean;
  orphanCount: number;
  missingRate: number;
  anomalyPenalty: number;
}

export interface SchemaGraph {
  tables: TableSchema[];
  edges: ForeignKeyEdge[];
}

export interface ImputedCellMeta {
  rowIndex: number;
  rowId: string | number | null;
  tableName: string;
  columnName: string;
  originalValue: unknown;
  guessedValue: string | number;
  method: string;
  basisColumns: string[];
  confidence: number;
  explanation: string;
}

export type AnomalySeverity = 'high' | 'medium' | 'low';
export type AnomalyKind =
  | 'numeric_outlier'
  | 'orphan_foreign_key'
  | 'casing_fragmentation'
  | 'duplicate_key'
  | 'negative_domain_violation'
  | 'cartesian_join_risk';

export type AnomalyCleanActionType =
  | 'normalize_text'
  | 'normalize_upper'
  | 'normalize_lower'
  | 'trim_only'
  | 'clamp_outlier'
  | 'nullify_and_impute'
  | 'abs_value'
  | 'set_zero'
  | 'set_null_only'
  | 'delete_rows'
  | 'deduplicate_rows'
  | 'remove_orphan_fk'
  | 'custom_instruction';

export interface AnomalyCleanOption {
  id: AnomalyCleanActionType;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface AnomalyRecord {
  id: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  tableName: string;
  columnName: string;
  affectedRowCount: number;
  sampleValues: string[];
  description: string;
  recommendedAction: string;
  cleanActionType: AnomalyCleanActionType;
  cleaningOptions?: AnomalyCleanOption[];
  cleared: boolean;
}

export interface DataProfile {
  tables: TableSchema[];
  edges: ForeignKeyEdge[];
  totalRows: number;
  totalMissingCells: number;
  totalAnomalies: number;
  imputedCells: ImputedCellMeta[];
  anomalies: AnomalyRecord[];
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  error?: string;
  imputedCellMarkers?: Record<string, Record<string, ImputedCellMeta>>;
  resultAnomalies?: string[];
}

export interface QueryCostBreakdown {
  planCost: number;
  joinCost: number;
  anomalyCost: number;
  semanticCost: number;
  latencyCost: number;
  failureCost: number;
  totalCost: number;
  planSteps: string[];
}

export interface CandidatePathQuery {
  id: string;
  label: string;
  strategy: string;
  sql: string;
  graphPathTables: string[];
  graphPathEdges: string[];
  usedColumns: Array<{ table: string; column: string }>;
  hopCount: number;
  semanticScore: number;
  anomalyPenalty: number;
  nullLossRate: number;
  resilienceScore: number;
  queryCost?: number;
  costBreakdown?: QueryCostBreakdown;
  selected: boolean;
  selectionReason: string;
  execution: QueryExecutionResult;
}

export interface RepairAttempt {
  attemptNumber: number;
  isInitial: boolean;
  sql: string;
  status: 'success' | 'error';
  errorMessage?: string;
  diagnosis?: string;
  executionMs: number;
}

export interface QueryGraphNode {
  id: string;
  operator: 'SCAN' | 'JOIN' | 'FILTER' | 'GROUP' | 'AGGREGATE' | 'SORT' | 'LIMIT' | 'PROJECT';
  label: string;
  detail: string;
  columns: string[];
  estimatedRows?: number;
}

export interface QueryGraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface QueryGraphPlan {
  nodes: QueryGraphNode[];
  edges: QueryGraphEdge[];
  usedTables: string[];
  usedColumns: Array<{ table: string; column: string }>;
  usedEdgeIds: string[];
}

export interface LlmFailoverMeta {
  keySlot: number;
  maskedKey: string;
  model: string;
  totalKeysConfigured: number;
  failovers: string[];
}

export interface TextToSqlResponse {
  mode: 'database' | 'text_only';
  question: string;
  inferredDdl?: string;
  selectedSql: string;
  explanation: string;
  candidates: CandidatePathQuery[];
  repairAttempts: RepairAttempt[];
  totalAttempts: number;
  healedOnRetry: boolean;
  queryGraph: QueryGraphPlan;
  result: QueryExecutionResult;
  dataWarnings: string[];
  llmMeta?: LlmFailoverMeta;
}

export interface ShowcaseExample {
  id: string;
  title: string;
  category: string;
  description: string;
  highlightFeature: string;
  mode: 'database' | 'text_only';
  sampleQuestions: string[];
}

export type SpiderHardness = 'Easy' | 'Medium' | 'Hard' | 'Extra Hard';

export interface SpiderTask {
  id: string;
  dbId: string;
  dbName: string;
  hardness: SpiderHardness;
  question: string;
  goldSql: string;
}

export interface SpiderTaskResult {
  taskId: string;
  dbId: string;
  hardness: SpiderHardness;
  question: string;
  goldSql: string;
  predictedSql: string;
  executionMatch: boolean;
  componentMatchF1: number;
  attemptsUsed: number;
  healedOnRetry: boolean;
  executionMs: number;
  goldRowCount: number;
  predictedRowCount: number;
  queryCost?: number;
  keySlot?: number;
  error?: string;
}

export interface SpiderBenchmarkSummary {
  totalTasks: number;
  executedTasks: number;
  executionAccuracy: number;
  firstPassAccuracy: number;
  healedAccuracy: number;
  avgComponentF1: number;
  avgLatencyMs: number;
  avgQueryCost?: number;
  failoverEvents?: string[];
  byHardness: Record<
    SpiderHardness,
    { total: number; passed: number; accuracy: number }
  >;
  results: SpiderTaskResult[];
}

export interface SpiderDatasetInfo {
  downloaded: boolean;
  datasetDir: string;
  datasetName: string;
  totalTasks: number;
  totalDatabases: number;
  hardnessCounts: Record<SpiderHardness, number>;
  previewTasks: SpiderTask[];
}

export interface SpiderJobStatus {
  jobId: string | null;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error';
  completed: number;
  total: number;
  error: string | null;
  activeKeySlot?: number;
  configuredKeys?: number;
  failoverEvents?: string[];
  summary: SpiderBenchmarkSummary | null;
}

