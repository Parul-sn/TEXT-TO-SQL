import express, { type Request, type Response, type Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  detectCasingAndWhitespaceAnomalies,
  detectNumericOutliers,
  imputeMissingValues,
  isMissingValue,
} from './src/shared/dataQuality.ts';
import {
  parseGeneralLanguageCleaningRule,
  type ParsedCleaningPlan,
} from './src/shared/anomalyCleaner.ts';
import {
  calculateQueryCost,
  enumerateJoinPaths,
  parseSqlToQueryGraph,
} from './src/shared/graphEngine.ts';
import { compareExecutionResults, computeComponentMatchF1 } from './src/shared/spiderComparator.ts';
import type {
  AnomalyRecord,
  CandidatePathQuery,
  ColumnSchema,
  DataProfile,
  ForeignKeyEdge,
  ImputedCellMeta,
  LlmFailoverMeta,
  QueryExecutionResult,
  RepairAttempt,
  ShowcaseExample,
  SpiderBenchmarkSummary,
  SpiderDatasetInfo,
  SpiderHardness,
  SpiderJobStatus,
  SpiderTask,
  SpiderTaskResult,
  TableSchema,
} from './src/shared/types.ts';

interface ShowcaseSeed extends ShowcaseExample {
  sqlSeed: string;
}

const SHOWCASE_EXAMPLES: ShowcaseSeed[] = [
  {
    id: 'ecommerce_multipath',
    title: 'E-Commerce Multi-Path & Anomalies',
    category: 'Multi-Path Graph Routing',
    description:
      '6-table commerce graph with a corrupted legacy shortcut (Orders.legacy_customer_id) alongside a clean verified path (Orders -> Invoices -> Customers), plus casing fragmentation and an order outlier.',
    highlightFeature:
      'Generates multiple graph-path SQL candidates, scores resilience, and highlights Selected vs Not-Selected paths.',
    mode: 'database',
    sampleQuestions: [
      'Show total verified order amount and order count per customer name and region',
      'Which warehouse shipped the highest total quantity of electronics products?',
      'List all customers whose average order amount exceeds 300',
    ],
    sqlSeed: `
CREATE TABLE Customers (
  customer_id INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL,
  region TEXT,
  tier TEXT
);
CREATE TABLE Warehouses (
  warehouse_id INTEGER PRIMARY KEY,
  warehouse_name TEXT NOT NULL,
  city TEXT NOT NULL
);
CREATE TABLE Products (
  product_id INTEGER PRIMARY KEY,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit_price REAL NOT NULL
);
CREATE TABLE Invoices (
  invoice_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  issued_date TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES Customers(customer_id)
);
CREATE TABLE Orders (
  order_id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  legacy_customer_id INTEGER,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  total_amount REAL,
  order_date TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES Invoices(invoice_id),
  FOREIGN KEY (legacy_customer_id) REFERENCES Customers(customer_id),
  FOREIGN KEY (product_id) REFERENCES Products(product_id)
);
CREATE TABLE Shipments (
  shipment_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  carrier TEXT,
  delivery_days INTEGER,
  FOREIGN KEY (order_id) REFERENCES Orders(order_id),
  FOREIGN KEY (warehouse_id) REFERENCES Warehouses(warehouse_id)
);
INSERT INTO Customers VALUES
  (1, 'Aarav Mehta', 'North America', 'Enterprise'),
  (2, 'Elena Rostova', 'north america ', 'Enterprise'),
  (3, 'Liam OConnor', 'Europe', 'Growth'),
  (4, 'Sofia Chen', 'Asia Pacific', 'Enterprise'),
  (5, 'Marcus Vance', 'Europe', NULL),
  (6, 'Priya Nair', 'Asia Pacific', 'Growth');
INSERT INTO Warehouses VALUES
  (10, 'Newark Hub', 'Newark'),
  (20, 'Rotterdam Depot', 'Rotterdam'),
  (30, 'Singapore Port', 'Singapore');
INSERT INTO Products VALUES
  (101, 'Edge Telemetry Gateway', 'Electronics', 420.0),
  (102, 'Industrial Thermal Sensor', 'Electronics', 180.0),
  (103, 'Carbon Rack Enclosure', 'Hardware', 650.0),
  (104, 'Precision Fiber Switch', 'Electronics', 510.0);
INSERT INTO Invoices VALUES
  (1001, 1, '2026-01-12', 'Paid'),
  (1002, 2, '2026-01-15', 'Paid'),
  (1003, 3, '2026-01-19', 'Paid'),
  (1004, 4, '2026-02-02', 'Paid'),
  (1005, 5, '2026-02-08', 'Pending'),
  (1006, 6, '2026-02-14', 'Paid'),
  (1007, 1, '2026-02-21', 'Paid'),
  (1008, 4, '2026-03-01', 'Paid');
INSERT INTO Orders VALUES
  (501, 1001, 1, 101, 2, 840.0, '2026-01-12'),
  (502, 1002, 999, 102, 3, 540.0, '2026-01-15'),
  (503, 1003, NULL, 103, 1, 650.0, '2026-01-19'),
  (504, 1004, 4, 104, 2, 1020.0, '2026-02-02'),
  (505, 1005, 888, 102, 2, NULL, '2026-02-08'),
  (506, 1006, NULL, 101, 1, 420.0, '2026-02-14'),
  (507, 1007, 1, 104, 1, 510.0, '2026-02-21'),
  (508, 1008, 4, 103, 2, 98500.0, '2026-03-01');
INSERT INTO Shipments VALUES
  (701, 501, 10, 'FedEx Freight', 3),
  (702, 502, 10, 'DHL Express', 4),
  (703, 503, 20, 'Maersk Air', 5),
  (704, 504, 30, 'DHL Express', 2),
  (705, 505, 20, 'N/A', 6),
  (706, 506, 30, 'DHL Express', 3),
  (707, 507, 10, 'FedEx Freight', 2),
  (708, 508, 30, 'DHL Express', 4);
`,
  },
  {
    id: 'hr_missing_imputation',
    title: 'HR Payroll & Missing Imputation',
    category: 'Missing Value Imputation',
    description:
      'Workforce and department payroll database with intentional NULL and N/A gaps in salary, bonus, and office location, plus a negative salary domain error.',
    highlightFeature:
      'Detects missing values, approximates them via peer-group statistics, and explicitly tags GUESSED / FILLED cells.',
    mode: 'database',
    sampleQuestions: [
      'Show each employee name, department name, salary, and bonus',
      'What is the average salary and total headcount by department?',
      'Find all employees assigned to active cloud projects',
    ],
    sqlSeed: `
CREATE TABLE Departments (
  dept_id INTEGER PRIMARY KEY,
  dept_name TEXT NOT NULL,
  cost_center TEXT NOT NULL
);
CREATE TABLE Employees (
  emp_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  role_level TEXT NOT NULL,
  salary REAL,
  bonus REAL,
  office_city TEXT,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);
CREATE TABLE Projects (
  project_id INTEGER PRIMARY KEY,
  project_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  budget REAL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);
CREATE TABLE Assignments (
  assignment_id INTEGER PRIMARY KEY,
  emp_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  allocation_pct INTEGER,
  FOREIGN KEY (emp_id) REFERENCES Employees(emp_id),
  FOREIGN KEY (project_id) REFERENCES Projects(project_id)
);
INSERT INTO Departments VALUES
  (1, 'Engineering', 'CC-100'),
  (2, 'Data Science', 'CC-200'),
  (3, 'Product Design', 'CC-300');
INSERT INTO Employees VALUES
  (101, 'Nadia Kapoor', 1, 'Senior', 142000, 18000, 'San Francisco'),
  (102, 'Lucas Meyer', 1, 'Senior', 138000, 16500, 'San Francisco'),
  (103, 'Hannah Brooks', 1, 'Senior', NULL, 17000, 'N/A'),
  (104, 'Devon Brooks', 1, 'Mid', 112000, NULL, 'Austin'),
  (105, 'Rohan Verma', 2, 'Senior', 148000, 21000, 'New York'),
  (106, 'Chloe Martin', 2, 'Senior', 152000, 22000, 'New York'),
  (107, 'Tariq Al-Mansoor', 2, 'Senior', NULL, NULL, ''),
  (108, 'Grace Lin', 3, 'Mid', 105000, 11000, 'Seattle'),
  (109, 'Mateo Silva', 3, 'Mid', -45000, 10500, 'Seattle'),
  (110, 'Zoe Foster', 3, 'Mid', 108000, NULL, 'Seattle');
INSERT INTO Projects VALUES
  (201, 'Cloud Query Engine', 1, 640000),
  (202, 'Anomaly Telemetry', 2, 490000),
  (203, 'Graph Workspace UI', 3, NULL);
INSERT INTO Assignments VALUES
  (1, 101, 201, 80),
  (2, 103, 201, 100),
  (3, 105, 202, 90),
  (4, 107, 202, 75),
  (5, 108, 203, 100),
  (6, 110, 203, 60);
`,
  },
  {
    id: 'clinical_self_healing',
    title: 'Clinical Trial & Sensor Repair',
    category: 'Anomaly & Self-Healing',
    description:
      'Biomedical trial dataset with sensor spike outliers (systolic BP 980 mmHg), casing drift in trial arms, and missing biomarker scores.',
    highlightFeature:
      'Showcases IQR outlier detection, one-click anomaly clearing, and 5-retry iterative SQL repair.',
    mode: 'database',
    sampleQuestions: [
      'Calculate average systolic blood pressure and biomarker score per trial arm',
      'Which patients have recorded measurements above 140 systolic_bp?',
      'List patient names alongside their prescribed medication dosage',
    ],
    sqlSeed: `
CREATE TABLE Trials (
  trial_id INTEGER PRIMARY KEY,
  trial_name TEXT NOT NULL,
  sponsor TEXT NOT NULL
);
CREATE TABLE Patients (
  patient_uid INTEGER PRIMARY KEY,
  patient_name TEXT NOT NULL,
  age INTEGER NOT NULL,
  trial_id INTEGER NOT NULL,
  trial_arm TEXT NOT NULL,
  FOREIGN KEY (trial_id) REFERENCES Trials(trial_id)
);
CREATE TABLE Medications (
  med_id INTEGER PRIMARY KEY,
  med_name TEXT NOT NULL,
  dosage_mg INTEGER NOT NULL
);
CREATE TABLE LabMeasurements (
  measurement_id INTEGER PRIMARY KEY,
  patient_uid INTEGER NOT NULL,
  med_id INTEGER NOT NULL,
  systolic_bp REAL,
  biomarker_score REAL,
  visit_week INTEGER NOT NULL,
  FOREIGN KEY (patient_uid) REFERENCES Patients(patient_uid),
  FOREIGN KEY (med_id) REFERENCES Medications(med_id)
);
INSERT INTO Trials VALUES
  (1, 'CardioShield Phase III', 'BioNova'),
  (2, 'NeuroPulse Phase II', 'Helix Labs');
INSERT INTO Patients VALUES
  (1, 'Arthur Pendelton', 58, 1, 'Treatment A'),
  (2, 'Beatrice Zhao', 62, 1, 'treatment a '),
  (3, 'Carlos Mendez', 54, 1, 'Placebo'),
  (4, 'Diana Novak', 49, 2, 'Treatment A'),
  (5, 'Edward Kim', 67, 2, 'Placebo'),
  (6, 'Fatima Zahra', 51, 1, 'Placebo');
INSERT INTO Medications VALUES
  (11, 'CardioStat', 25),
  (12, 'PlaceboSaline', 0),
  (13, 'NeuroCalm', 40);
INSERT INTO LabMeasurements VALUES
  (1, 1, 11, 128, 7.4, 4),
  (2, 2, 11, 134, NULL, 4),
  (3, 3, 12, 146, 5.1, 4),
  (4, 4, 13, 980, 8.2, 4),
  (5, 5, 12, 139, 4.9, 4),
  (6, 6, 12, 142, NULL, 4),
  (7, 1, 11, 124, 7.8, 8),
  (8, 2, 11, 131, 7.5, 8);
`,
  },
  {
    id: 'university_spider_style',
    title: 'University Transcripts (Spider Graph)',
    category: 'Clean Relational Graph',
    description:
      '5-table academic schema modeled after Spider benchmark topology with Students, Departments, Instructors, Courses, and Enrollments.',
    highlightFeature:
      'Demonstrates clean column-to-column FK wiring and relational Query Graph execution DAGs.',
    mode: 'database',
    sampleQuestions: [
      'Find the names of students who earned an A in Computer Science courses',
      'How many students are enrolled in each department ordered by enrollment count descending?',
      'Which instructor teaches the course with the highest average credits?',
    ],
    sqlSeed: `
CREATE TABLE Departments (
  dept_id INTEGER PRIMARY KEY,
  dept_name TEXT NOT NULL,
  building TEXT NOT NULL
);
CREATE TABLE Instructors (
  instructor_id INTEGER PRIMARY KEY,
  instructor_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);
CREATE TABLE Courses (
  course_id INTEGER PRIMARY KEY,
  course_code TEXT NOT NULL,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  instructor_id INTEGER NOT NULL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id),
  FOREIGN KEY (instructor_id) REFERENCES Instructors(instructor_id)
);
CREATE TABLE Students (
  student_id INTEGER PRIMARY KEY,
  student_name TEXT NOT NULL,
  major_dept_id INTEGER NOT NULL,
  gpa REAL NOT NULL,
  FOREIGN KEY (major_dept_id) REFERENCES Departments(dept_id)
);
CREATE TABLE Enrollments (
  enrollment_id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  semester TEXT NOT NULL,
  grade TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES Students(student_id),
  FOREIGN KEY (course_id) REFERENCES Courses(course_id)
);
INSERT INTO Departments VALUES
  (1, 'Computer Science', 'Gates Hall'),
  (2, 'Mathematics', 'Euler Center'),
  (3, 'Physics', 'Bohr Pavilion');
INSERT INTO Instructors VALUES
  (10, 'Dr. Alan Turing', 1),
  (11, 'Dr. Ada Lovelace', 1),
  (12, 'Dr. Emmy Noether', 2),
  (13, 'Dr. Richard Feynman', 3);
INSERT INTO Courses VALUES
  (101, 'CS-401', 'Database Systems', 4, 1, 10),
  (102, 'CS-450', 'Machine Learning', 4, 1, 11),
  (103, 'MATH-310', 'Abstract Algebra', 3, 2, 12),
  (104, 'PHYS-220', 'Quantum Mechanics', 4, 3, 13);
INSERT INTO Students VALUES
  (1001, 'Maya Lin', 1, 3.92),
  (1002, 'Ethan Cole', 1, 3.65),
  (1003, 'Sora Takahashi', 2, 3.88),
  (1004, 'Noah Patel', 3, 3.51),
  (1005, 'Clara Oswald', 1, 3.79);
INSERT INTO Enrollments VALUES
  (1, 1001, 101, 'Fall 2026', 'A'),
  (2, 1001, 102, 'Fall 2026', 'A'),
  (3, 1002, 101, 'Fall 2026', 'B+'),
  (4, 1003, 103, 'Fall 2026', 'A'),
  (5, 1004, 104, 'Fall 2026', 'A-'),
  (6, 1005, 101, 'Fall 2026', 'A'),
  (7, 1003, 102, 'Fall 2026', 'B');
`,
  },
  {
    id: 'text_only_mode',
    title: 'Text-Only (No Database File)',
    category: 'Schema-Free Text-to-SQL',
    description:
      'Pure natural-language Text-to-SQL mode when no .sql or .db file is provided. Infers relational DDL, generates SQL, and visualizes the Query Graph.',
    highlightFeature: 'Works with zero files provided—generates SQL and inferred schema directly from text.',
    mode: 'text_only',
    sampleQuestions: [
      'Find the top 5 customers who spent more than $2,000 in the last 90 days across all orders',
      'Calculate monthly recurring revenue growth rate by subscription plan for 2026',
      'List flights with delays longer than 45 minutes departing from New York airports',
    ],
    sqlSeed: '',
  },
];

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
      useOldExtensionFunctions: false,
    });
  }
  return sqlJsPromise;
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function toTitleCase(val: string): string {
  return val
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function execRows(db: Database, sql: string): { columns: string[]; rows: Record<string, unknown>[] } {
  const res = db.exec(sql);
  if (!res.length) return { columns: [], rows: [] };
  const first = res[0];
  const cols = first.columns;
  const rows = first.values.map((vals) => {
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      row[c] = vals[i];
    });
    return row;
  });
  return { columns: cols, rows };
}

function readDotenvMap(envPath = '.env'): Record<string, string> {
  const abs = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(abs)) return {};
  const map: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(abs, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) map[key] = val;
  }
  return map;
}

interface LlmConfigSlot {
  slot: number;
  apiKey: string;
  maskedKey: string;
  baseUrl: string;
  model: string;
  timeoutSec: number;
}

function maskApiKey(key: string): string {
  const clean = key.trim();
  if (clean.length <= 8) return '***';
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function resolveLlmConfigs(): LlmConfigSlot[] {
  const dotenv = readDotenvMap();
  const pick = (keys: string[]): string => {
    for (const k of keys) {
      const v = (dotenv[k] ?? process.env[k] ?? '').trim();
      if (v) return v;
    }
    return '';
  };

  const sharedBaseUrl = pick(['LLM_BASE_URL', 'OPENAI_BASE_URL', 'TEXT_TO_SQL_BASE_URL']).replace(
    /\/+$/,
    ''
  );
  const sharedModel = pick(['LLM_MODEL', 'OPENAI_MODEL', 'TEXT_TO_SQL_MODEL']);
  const timeoutRaw = pick(['LLM_TIMEOUT_SEC']);
  const timeoutParsed = Number(timeoutRaw);
  const timeoutSec = Number.isInteger(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : 60;

  const rawSlots: Array<{ slot: number; key: string }> = [
    {
      slot: 1,
      key: pick([
        'LLM_API_KEY',
        'LLM_API_KEY_1',
        'TEXT_TO_SQL_API_KEY',
        'text-to-sql',
        'TEXT_TO_SQL_KEY',
        'TEXT_TO_SQL',
        'OPENAI_API_KEY',
        'API_KEY',
      ]),
    },
    { slot: 2, key: pick(['LLM_API_KEY_2', 'TEXT_TO_SQL_API_KEY_2']) },
    { slot: 3, key: pick(['LLM_API_KEY_3', 'TEXT_TO_SQL_API_KEY_3']) },
  ];

  const multiRaw = pick(['LLM_API_KEYS']);
  if (multiRaw) {
    multiRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((k, idx) => rawSlots.push({ slot: rawSlots.length + idx + 1, key: k }));
  }

  const seen = new Set<string>();
  const slots: LlmConfigSlot[] = [];
  for (const item of rawSlots) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    const slotBase = (
      pick([`LLM_BASE_URL_${item.slot}`, `TEXT_TO_SQL_BASE_URL_${item.slot}`]) || sharedBaseUrl
    ).replace(/\/+$/, '');
    const slotModel =
      pick([`LLM_MODEL_${item.slot}`, `TEXT_TO_SQL_MODEL_${item.slot}`]) || sharedModel;

    slots.push({
      slot: item.slot,
      apiKey: item.key,
      maskedKey: maskApiKey(item.key),
      baseUrl: slotBase,
      model: slotModel,
      timeoutSec,
    });
    if (slots.length >= 3) break;
  }

  const missing: string[] = [];
  if (slots.length === 0) missing.push('LLM_API_KEY');
  if (!sharedBaseUrl && !slots.every((s) => Boolean(s.baseUrl))) missing.push('LLM_BASE_URL');
  if (!sharedModel && !slots.every((s) => Boolean(s.model))) missing.push('LLM_MODEL');
  if (missing.length > 0) {
    throw new Error(
      `LLM configuration is incomplete in .env. Please fill in: ${missing.join(', ')}.`
    );
  }

  return slots;
}

function resolveLlmConfig(): LlmConfigSlot {
  return resolveLlmConfigs()[0];
}

function isLlmConfiguredNode(): boolean {
  try {
    resolveLlmConfigs();
    return true;
  } catch {
    return false;
  }
}

interface NodeSession {
  sessionId: string;
  mode: 'database' | 'text_only';
  sourceName: string;
  sourceKind: 'example' | 'sql_file' | 'db_file' | 'text_only';
  exampleId: string | null;
  dbBytes: Uint8Array | null;
  snapshotBytes: Uint8Array | null;
}

const sessions = new Map<string, NodeSession>();

function getSessionId(req: Request): string {
  const raw = String(req.headers['x-session-id'] || req.query.sessionId || 'default').trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(raw) ? raw : 'default';
}

async function openSessionDb(bytes: Uint8Array): Promise<Database> {
  const SQL = await getSqlJs();
  return new SQL.Database(bytes);
}

async function createExampleSession(sessionId: string, exampleId: string): Promise<NodeSession> {
  const seed = SHOWCASE_EXAMPLES.find((e) => e.id === exampleId) ?? SHOWCASE_EXAMPLES[0];
  if (seed.mode === 'text_only') {
    const sess: NodeSession = {
      sessionId,
      mode: 'text_only',
      sourceName: 'Text-Only Mode (No DB Attached)',
      sourceKind: 'text_only',
      exampleId: seed.id,
      dbBytes: null,
      snapshotBytes: null,
    };
    sessions.set(sessionId, sess);
    return sess;
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database();
  try {
    db.exec(seed.sqlSeed);
    const exported = db.export();
    const sess: NodeSession = {
      sessionId,
      mode: 'database',
      sourceName: seed.title,
      sourceKind: 'example',
      exampleId: seed.id,
      dbBytes: new Uint8Array(exported),
      snapshotBytes: new Uint8Array(exported),
    };
    sessions.set(sessionId, sess);
    return sess;
  } finally {
    db.close();
  }
}

async function getOrCreateSession(sessionId: string): Promise<NodeSession> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  return createExampleSession(sessionId, 'ecommerce_multipath');
}

function profileDatabase(db: Database): DataProfile {
  const tblRes = execRows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );
  const tableNames = tblRes.rows.map((r) => String(r.name));

  const tables: TableSchema[] = [];
  const edges: ForeignKeyEdge[] = [];
  const anomalies: AnomalyRecord[] = [];
  const imputedCells: ImputedCellMeta[] = [];
  const tableRowsMap = new Map<string, Record<string, unknown>[]>();
  const pkMap = new Map<string, string | undefined>();
  const fkLookup = new Map<string, Map<string, { table: string; to: string }>>();
  let totalRows = 0;
  let totalMissingCells = 0;

  for (const tName of tableNames) {
    const pragmaCols = execRows(db, `PRAGMA table_info(${quoteIdent(tName)});`).rows;
    const pragmaFks = execRows(db, `PRAGMA foreign_key_list(${quoteIdent(tName)});`).rows;
    const fkCols = new Map<string, { table: string; to: string }>();
    for (const fk of pragmaFks) {
      fkCols.set(String(fk.from), { table: String(fk.table), to: String(fk.to) });
    }
    fkLookup.set(tName, fkCols);

    const rowsRes = execRows(db, `SELECT * FROM ${quoteIdent(tName)};`);
    const rows = rowsRes.rows;
    tableRowsMap.set(tName, rows);
    totalRows += rows.length;

    const pkCol = pragmaCols.find((c) => Number(c.pk) > 0);
    const pkName = pkCol ? String(pkCol.name) : undefined;
    pkMap.set(tName, pkName);

    const cols: ColumnSchema[] = [];
    for (const c of pragmaCols) {
      const colName = String(c.name);
      const fk = fkCols.get(colName);
      const missingCount = rows.filter((r) => isMissingValue(r[colName])).length;
      totalMissingCells += missingCount;

      let colAnomalies = 0;
      const outlier = detectNumericOutliers(rows, tName, colName);
      if (outlier) {
        anomalies.push(outlier);
        colAnomalies += outlier.affectedRowCount;
      }
      if (!Number(c.pk) && !fk) {
        const casing = detectCasingAndWhitespaceAnomalies(rows, tName, colName);
        if (casing) {
          anomalies.push(casing);
          colAnomalies += casing.affectedRowCount;
        }
      }

      cols.push({
        name: colName,
        type: String(c.type || 'TEXT') || 'TEXT',
        isPrimaryKey: Number(c.pk) > 0,
        isForeignKey: Boolean(fk),
        referencesTable: fk?.table,
        referencesColumn: fk?.to,
        nullable: Number(c.notnull) === 0,
        missingCount,
        missingRate: rows.length ? Math.round((missingCount / rows.length) * 1000) / 1000 : 0,
        anomalyCount: colAnomalies,
      });
    }

    tables.push({ name: tName, rowCount: rows.length, columns: cols });

    const { imputedCells: tImputed } = imputeMissingValues(tName, rows, cols, pkName);
    imputedCells.push(...tImputed);
  }

  for (const t of tables) {
    const fkCols = fkLookup.get(t.name) ?? new Map();
    const rows = tableRowsMap.get(t.name) ?? [];
    for (const [fromCol, target] of fkCols.entries()) {
      const targetRows = tableRowsMap.get(target.table) ?? [];
      const targetSet = new Set(
        targetRows
          .map((r) => r[target.to])
          .filter((v) => !isMissingValue(v))
          .map((v) => String(v))
      );

      let orphanCount = 0;
      let missingCount = 0;
      const orphanSamples: string[] = [];
      for (const r of rows) {
        const val = r[fromCol];
        if (isMissingValue(val)) {
          missingCount++;
        } else if (!targetSet.has(String(val))) {
          orphanCount++;
          if (orphanSamples.length < 4) orphanSamples.push(String(val));
        }
      }

      const missingRate = rows.length ? Math.round((missingCount / rows.length) * 1000) / 1000 : 0;
      const orphanRate = rows.length ? orphanCount / rows.length : 0;
      const anomalyPenalty = Math.min(1, Math.round((orphanRate * 2.5 + missingRate * 0.8) * 1000) / 1000);

      if (orphanCount > 0) {
        anomalies.push({
          id: `orphan_${t.name}_${fromCol}`,
          kind: 'orphan_foreign_key',
          severity: 'high',
          tableName: t.name,
          columnName: fromCol,
          affectedRowCount: orphanCount,
          sampleValues: orphanSamples,
          description: `${orphanCount} row(s) in ${t.name}.${fromCol} reference non-existent ${target.table}.${target.to} keys, causing silent INNER JOIN row drops.`,
          recommendedAction: 'Nullify orphan keys or delete broken child rows.',
          cleanActionType: 'remove_orphan_fk',
          cleaningOptions: [
            {
              id: 'remove_orphan_fk',
              label: 'Set Orphan Keys to NULL',
              description: `Keep ${orphanCount} row(s) in ${t.name} while setting invalid ${fromCol} keys to NULL.`,
              recommended: true,
            },
            {
              id: 'delete_rows',
              label: 'Delete Orphan Rows',
              description: `Delete ${orphanCount} child row(s) referencing missing ${target.table}.${target.to} keys.`,
            },
          ],
          cleared: false,
        });
      }

      edges.push({
        id: `fk_${t.name}_${fromCol}_${target.table}_${target.to}`,
        fromTable: t.name,
        fromColumn: fromCol,
        toTable: target.table,
        toColumn: target.to,
        inferred: false,
        orphanCount,
        missingRate,
        anomalyPenalty,
      });
    }
  }

  return {
    tables,
    edges,
    totalRows,
    totalMissingCells,
    totalAnomalies: anomalies.length,
    imputedCells,
    anomalies,
  };
}

function executeCleaningPlanOnDb(
  db: Database,
  profile: DataProfile,
  tableName: string,
  columnName: string,
  plan: ParsedCleaningPlan
): { appliedSql: string; message: string; actionSummary: string } {
  const qTbl = quoteIdent(tableName);
  const qCol = quoteIdent(columnName);

  const computeIqr = () => {
    const res = execRows(db, `SELECT rowid AS __rid, ${qCol} AS val FROM ${qTbl};`);
    const validVals: number[] = [];
    for (const r of res.rows) {
      if (typeof r.val === 'number' && !Number.isNaN(r.val)) {
        validVals.push(r.val);
      }
    }
    validVals.sort((a, b) => a - b);
    const q1 = validVals.length ? validVals[Math.floor(validVals.length * 0.25)] : 0;
    const q3 = validVals.length ? validVals[Math.floor(validVals.length * 0.75)] : 0;
    const iqr = q3 - q1;
    const lower = Math.max(0, q1 - 1.5 * iqr);
    const upper = q3 + 1.5 * iqr;
    return { lower, upper, rows: res.rows, count: validVals.length };
  };

  if (
    plan.actionKind === 'normalize_title' ||
    plan.actionKind === 'normalize_upper' ||
    plan.actionKind === 'normalize_lower' ||
    plan.actionKind === 'trim_whitespace'
  ) {
    const res = execRows(db, `SELECT rowid AS __rid, ${qCol} AS val FROM ${qTbl};`);
    let updated = 0;
    for (const r of res.rows) {
      if (typeof r.val !== 'string' || isMissingValue(r.val)) continue;
      const collapsed = r.val.trim().replace(/\s+/g, ' ');
      const cleaned =
        plan.actionKind === 'normalize_title'
          ? toTitleCase(collapsed)
          : plan.actionKind === 'normalize_upper'
          ? collapsed.toUpperCase()
          : plan.actionKind === 'normalize_lower'
          ? collapsed.toLowerCase()
          : collapsed;
      if (cleaned !== r.val) {
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [cleaned, r.__rid as number]);
        updated++;
      }
    }
    const appliedSql = `UPDATE ${qTbl} SET ${qCol} = ${plan.actionKind.toUpperCase()}(${qCol}); -- ${updated} row(s)`;
    const message = `${plan.description} (${updated} row(s) updated in ${tableName}.${columnName}).`;
    return { appliedSql, message, actionSummary: message };
  }

  if (plan.actionKind === 'nullify_orphan_fk' || plan.actionKind === 'delete_orphan_fk') {
    const edge = profile.edges.find(
      (e) => e.fromTable === tableName && e.fromColumn === columnName
    );
    if (!edge) {
      throw new Error(`No foreign-key relationship found on ${tableName}.${columnName}.`);
    }
    const qTarget = quoteIdent(edge.toTable);
    const qTargetCol = quoteIdent(edge.toColumn);
    if (plan.actionKind === 'delete_orphan_fk') {
      const sql = `DELETE FROM ${qTbl} WHERE ${qCol} IS NOT NULL AND ${qCol} NOT IN (SELECT ${qTargetCol} FROM ${qTarget} WHERE ${qTargetCol} IS NOT NULL);`;
      db.run(sql);
      const message = `Deleted orphan foreign-key row(s) from ${tableName}.`;
      return { appliedSql: sql, message, actionSummary: message };
    }
    const sql = `UPDATE ${qTbl} SET ${qCol} = NULL WHERE ${qCol} IS NOT NULL AND ${qCol} NOT IN (SELECT ${qTargetCol} FROM ${qTarget} WHERE ${qTargetCol} IS NOT NULL);`;
    db.run(sql);
    const message = `Nullified orphan foreign-key references in ${tableName}.${columnName}.`;
    return { appliedSql: sql, message, actionSummary: message };
  }

  if (
    plan.actionKind === 'set_negative_to' ||
    plan.actionKind === 'abs_negative' ||
    plan.actionKind === 'delete_negative' ||
    plan.actionKind === 'nullify_negative'
  ) {
    const res = execRows(db, `SELECT rowid AS __rid, ${qCol} AS val FROM ${qTbl};`);
    let touched = 0;
    for (const r of res.rows) {
      if (isMissingValue(r.val)) continue;
      const num = Number(r.val);
      if (Number.isNaN(num) || num >= 0) continue;
      if (plan.actionKind === 'delete_negative') {
        db.run(`DELETE FROM ${qTbl} WHERE rowid = ?;`, [r.__rid as number]);
      } else if (plan.actionKind === 'nullify_negative') {
        db.run(`UPDATE ${qTbl} SET ${qCol} = NULL WHERE rowid = ?;`, [r.__rid as number]);
      } else if (plan.actionKind === 'abs_negative') {
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [Math.abs(num), r.__rid as number]);
      } else {
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [
          (plan.replacementValue ?? 0) as number,
          r.__rid as number,
        ]);
      }
      touched++;
    }
    const appliedSql = `UPDATE/DELETE ${qTbl} ON ${qCol} < 0; -- ${touched} row(s)`;
    const message = `${plan.description} (${touched} row(s) updated in ${tableName}.${columnName}).`;
    return { appliedSql, message, actionSummary: message };
  }

  if (
    plan.actionKind === 'cap_above' ||
    plan.actionKind === 'delete_above' ||
    plan.actionKind === 'nullify_above' ||
    plan.actionKind === 'floor_below' ||
    plan.actionKind === 'delete_below' ||
    plan.actionKind === 'nullify_below'
  ) {
    const thr = Number(plan.threshold ?? 0);
    const isAbove = plan.actionKind.endsWith('_above');
    const res = execRows(db, `SELECT rowid AS __rid, ${qCol} AS val FROM ${qTbl};`);
    let touched = 0;
    for (const r of res.rows) {
      if (isMissingValue(r.val)) continue;
      const num = Number(r.val);
      if (Number.isNaN(num)) continue;
      const hit = isAbove ? num > thr : num < thr;
      if (!hit) continue;
      if (plan.actionKind.startsWith('delete_')) {
        db.run(`DELETE FROM ${qTbl} WHERE rowid = ?;`, [r.__rid as number]);
      } else if (plan.actionKind.startsWith('nullify_')) {
        db.run(`UPDATE ${qTbl} SET ${qCol} = NULL WHERE rowid = ?;`, [r.__rid as number]);
      } else {
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [
          (plan.replacementValue ?? thr) as number,
          r.__rid as number,
        ]);
      }
      touched++;
    }
    const op = isAbove ? '>' : '<';
    const appliedSql = `${plan.actionKind.startsWith('delete_') ? 'DELETE FROM' : 'UPDATE'} ${qTbl} WHERE ${qCol} ${op} ${thr}; -- ${touched} row(s)`;
    const message = `${plan.description} (${touched} row(s) updated in ${tableName}.${columnName}).`;
    return { appliedSql, message, actionSummary: message };
  }

  if (plan.actionKind === 'replace_value') {
    const matchVal = String(plan.matchValue ?? '').trim().toLowerCase();
    const repVal = String(plan.replacementValue ?? '');
    const res = execRows(db, `SELECT rowid AS __rid, ${qCol} AS val FROM ${qTbl};`);
    let updated = 0;
    for (const r of res.rows) {
      if (r.val !== null && r.val !== undefined && String(r.val).trim().toLowerCase() === matchVal) {
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [repVal, r.__rid as number]);
        updated++;
      }
    }
    const appliedSql = `UPDATE ${qTbl} SET ${qCol} = '${repVal}' WHERE LOWER(TRIM(${qCol})) = '${matchVal}'; -- ${updated} row(s)`;
    const message = `Replaced "${plan.matchValue}" with "${repVal}" in ${updated} row(s).`;
    return { appliedSql, message, actionSummary: message };
  }

  if (
    plan.actionKind === 'delete_missing' ||
    plan.actionKind === 'fill_missing_value' ||
    plan.actionKind === 'impute_missing'
  ) {
    const res = execRows(db, `SELECT rowid AS __rid, * FROM ${qTbl};`);
    if (plan.actionKind === 'delete_missing') {
      let deleted = 0;
      for (const r of res.rows) {
        if (isMissingValue(r[columnName])) {
          db.run(`DELETE FROM ${qTbl} WHERE rowid = ?;`, [r.__rid as number]);
          deleted++;
        }
      }
      const message = `Deleted ${deleted} row(s) with missing ${tableName}.${columnName}.`;
      return {
        appliedSql: `DELETE FROM ${qTbl} WHERE ${qCol} IS NULL OR TRIM(CAST(${qCol} AS TEXT)) = ''; -- ${deleted} row(s)`,
        message,
        actionSummary: message,
      };
    }
    if (plan.actionKind === 'fill_missing_value') {
      const rep = (plan.replacementValue ?? '') as string | number;
      let updated = 0;
      for (const r of res.rows) {
        if (isMissingValue(r[columnName])) {
          db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [rep, r.__rid as number]);
          updated++;
        }
      }
      const message = `Filled ${updated} missing cell(s) in ${tableName}.${columnName} with ${String(rep)}.`;
      return {
        appliedSql: `UPDATE ${qTbl} SET ${qCol} = ${JSON.stringify(rep)} WHERE ${qCol} IS NULL; -- ${updated} row(s)`,
        message,
        actionSummary: message,
      };
    }
    const tableSchema = profile.tables.find((t) => t.name === tableName);
    let updated = 0;
    if (tableSchema) {
      const pk = tableSchema.columns.find((c) => c.isPrimaryKey)?.name;
      const { imputedCells } = imputeMissingValues(tableName, res.rows, tableSchema.columns, pk);
      for (const cell of imputedCells) {
        if (cell.columnName === columnName) {
          const rid = res.rows[cell.rowIndex]?.__rid;
          if (rid !== undefined) {
            db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [
              cell.guessedValue,
              rid as number,
            ]);
            updated++;
          }
        }
      }
    }
    const message = `Imputed ${updated} missing cell(s) in ${tableName}.${columnName} from peer statistics.`;
    return {
      appliedSql: `UPDATE ${qTbl} SET ${qCol} = PEER_IMPUTED_VALUE WHERE ${qCol} IS NULL; -- ${updated} row(s)`,
      message,
      actionSummary: message,
    };
  }

  const { lower, upper, rows } = computeIqr();
  let touched = 0;
  for (const r of rows) {
    if (isMissingValue(r.val)) continue;
    const num = Number(r.val);
    if (Number.isNaN(num)) continue;
    if (num < lower || num > upper || num < 0) {
      if (plan.actionKind === 'delete_outliers_iqr') {
        db.run(`DELETE FROM ${qTbl} WHERE rowid = ?;`, [r.__rid as number]);
      } else if (plan.actionKind === 'nullify_outliers') {
        db.run(`UPDATE ${qTbl} SET ${qCol} = NULL WHERE rowid = ?;`, [r.__rid as number]);
      } else {
        const clamped = Math.round(Math.min(upper, Math.max(lower, num)) * 100) / 100;
        db.run(`UPDATE ${qTbl} SET ${qCol} = ? WHERE rowid = ?;`, [clamped, r.__rid as number]);
      }
      touched++;
    }
  }
  const message = `${plan.description} (${touched} row(s) updated in ${tableName}.${columnName}).`;
  return {
    appliedSql: `UPDATE/DELETE ${qTbl} ON ${qCol} OUTSIDE [${Math.round(lower)}, ${Math.round(upper)}]; -- ${touched} row(s)`,
    message,
    actionSummary: message,
  };
}

async function applyGeneralLanguageCleaningOnDb(
  db: Database,
  tableName: string,
  columnName: string,
  instruction: string
): Promise<{ appliedSql: string; message: string; actionSummary: string }> {
  const cleanInst = instruction.trim();
  if (!cleanInst) {
    throw new Error('Please enter a general-language cleaning instruction.');
  }
  const profile = profileDatabase(db);
  const tableMeta = profile.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
  if (!tableMeta) {
    throw new Error(`Table "${tableName}" does not exist in active database.`);
  }
  const colMeta = tableMeta.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
  if (!colMeta) {
    throw new Error(`Column "${columnName}" does not exist in table "${tableMeta.name}".`);
  }

  const plan = parseGeneralLanguageCleaningRule(cleanInst);
  if (plan) {
    return executeCleaningPlanOnDb(db, profile, tableMeta.name, colMeta.name, plan);
  }

  if (isLlmConfiguredNode()) {
    const sample = execRows(db, `SELECT * FROM ${quoteIdent(tableMeta.name)} LIMIT 8;`);
    const { parsed, meta } = await callLlmStructuredWithMeta(
      'You translate a plain-English data-cleaning rule for ONE SQLite table/column into a single safe UPDATE or DELETE SQLite statement. Never emit DROP, ALTER, CREATE, ATTACH, PRAGMA, or multiple statements.',
      `Target table: ${tableMeta.name}\nTarget column: ${colMeta.name} (${colMeta.type})\nColumns: ${sample.columns.join(', ')}\nSample rows: ${JSON.stringify(sample.rows.slice(0, 5))}\n\nUser instruction: ${cleanInst}\nReturn JSON with "sql" and "summary".`,
      '{"sql": "string", "summary": "string"}'
    );
    const stmt = cleanSqlOutput(String(parsed.sql || '')).replace(/;+$/, '').trim();
    const up = stmt.toUpperCase();
    if (stmt.includes(';') || (!up.startsWith('UPDATE ') && !up.startsWith('DELETE '))) {
      throw new Error('General-language rule must translate to a single UPDATE or DELETE statement.');
    }
    if (/(DROP|ALTER|ATTACH|DETACH|PRAGMA|CREATE|VACUUM)\s+/i.test(up)) {
      throw new Error('Disallowed SQL keyword in cleaning rule.');
    }
    db.run(stmt);
    const message = `${String(parsed.summary || cleanInst)} (applied via Key #${meta.keySlot})`;
    return { appliedSql: `${stmt};`, message, actionSummary: message };
  }

  throw new Error(
    'Could not parse that general-language instruction deterministically. Try phrases like: "set negative values to 0", "convert negative to positive", "cap values above 500 to 500", "replace \'old\' with \'new\'", "trim and title case", "fill missing with 0", or "delete rows with negative values".'
  );
}

async function cleanAnomalyOnDb(
  db: Database,
  anomalyId: string,
  actionType?: string,
  customInstruction?: string
): Promise<{ appliedSql: string; message: string; actionSummary: string }> {
  const profile = profileDatabase(db);
  const target = profile.anomalies.find((a) => a.id === anomalyId);
  if (!target) {
    return { appliedSql: '', message: 'Anomaly already cleared.', actionSummary: 'Anomaly already cleared.' };
  }

  if (customInstruction && customInstruction.trim()) {
    return applyGeneralLanguageCleaningOnDb(
      db,
      target.tableName,
      target.columnName,
      customInstruction
    );
  }

  const action = (actionType || target.cleanActionType).trim();
  const planMap: Record<string, ParsedCleaningPlan> = {
    normalize_text: { actionKind: 'normalize_title', description: 'Trim spaces and normalize text to Title Case.' },
    normalize_upper: { actionKind: 'normalize_upper', description: 'Trim spaces and convert text to UPPERCASE.' },
    normalize_lower: { actionKind: 'normalize_lower', description: 'Trim spaces and convert text to lowercase.' },
    trim_only: { actionKind: 'trim_whitespace', description: 'Trim leading, trailing, and duplicate spaces.' },
    remove_orphan_fk: { actionKind: 'nullify_orphan_fk', description: 'Set orphan foreign-key references to NULL.' },
    nullify_and_impute: { actionKind: 'nullify_outliers', description: 'Set out-of-range values to NULL for peer-group imputation.' },
    set_null_only: { actionKind: 'nullify_outliers', description: 'Set out-of-range values to NULL.' },
    clamp_outlier: { actionKind: 'clamp_outliers_iqr', description: 'Clamp statistical outliers to IQR fence bounds.' },
    abs_value: { actionKind: 'abs_negative', description: 'Convert negative values to positive (ABS).' },
    set_zero: { actionKind: 'set_negative_to', replacementValue: 0, description: 'Replace negative values with 0.' },
    delete_rows:
      target.kind === 'orphan_foreign_key'
        ? { actionKind: 'delete_orphan_fk', description: 'Delete rows with orphan foreign-key references.' }
        : { actionKind: 'delete_outliers_iqr', description: 'Delete anomalous rows from table.' },
  };

  const plan = planMap[action];
  if (!plan) {
    throw new Error(`Unsupported clean action: ${action}`);
  }
  return executeCleaningPlanOnDb(db, profile, target.tableName, target.columnName, plan);
}

function executeReadOnlyOnDb(
  db: Database,
  sql: string,
  applyImputationOverlay = true
): QueryExecutionResult {
  const start = performance.now();
  const clean = sql.trim();
  const upper = clean.toUpperCase();
  if (!clean) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionMs: 0,
      error: 'SQL query cannot be empty.',
    };
  }
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('PRAGMA')) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionMs: 0,
      error: 'Only read-only SELECT / WITH queries are permitted in execution.',
    };
  }

  try {
    const res = execRows(db, clean);
    const cols = res.columns;
    let rows = res.rows;
    const markers: Record<string, Record<string, ImputedCellMeta>> = {};
    const warnings: string[] = [];

    if (applyImputationOverlay && rows.length > 0) {
      const profile = profileDatabase(db);
      const colValueStats = new Map<string, { numeric: number[]; strings: string[] }>();
      for (const c of cols) {
        const nums: number[] = [];
        const strs: string[] = [];
        for (const r of rows) {
          const val = r[c];
          if (isMissingValue(val)) continue;
          const n = typeof val === 'number' ? val : Number(val);
          if (!Number.isNaN(n) && Number.isFinite(n)) nums.push(n);
          else strs.push(String(val));
        }
        colValueStats.set(c, { numeric: nums, strings: strs });
      }

      rows = rows.map((row, rIdx) => {
        const next = { ...row };
        for (const c of cols) {
          if (!isMissingValue(next[c])) continue;
          let matchedMeta: ImputedCellMeta | undefined;
          for (const ic of profile.imputedCells) {
            if (ic.columnName.toLowerCase() === c.toLowerCase()) {
              matchedMeta = ic;
              break;
            }
          }
          if (matchedMeta) {
            next[c] = matchedMeta.guessedValue;
            markers[String(rIdx)] = markers[String(rIdx)] ?? {};
            markers[String(rIdx)][c] = {
              ...matchedMeta,
              rowIndex: rIdx,
            };
          } else {
            const st = colValueStats.get(c);
            if (st && st.numeric.length > 0) {
              const avg = Math.round((st.numeric.reduce((a, b) => a + b, 0) / st.numeric.length) * 100) / 100;
              next[c] = avg;
              markers[String(rIdx)] = markers[String(rIdx)] ?? {};
              markers[String(rIdx)][c] = {
                rowIndex: rIdx,
                rowId: rIdx + 1,
                tableName: 'ResultProjection',
                columnName: c,
                originalValue: row[c] ?? null,
                guessedValue: avg,
                method: 'Result-Set Column Mean',
                basisColumns: [c],
                confidence: 0.62,
                explanation: `Missing value in ${c} approximated from observed result rows.`,
              };
            } else if (st && st.strings.length > 0) {
              const guessed = st.strings[0];
              next[c] = guessed;
              markers[String(rIdx)] = markers[String(rIdx)] ?? {};
              markers[String(rIdx)][c] = {
                rowIndex: rIdx,
                rowId: rIdx + 1,
                tableName: 'ResultProjection',
                columnName: c,
                originalValue: row[c] ?? null,
                guessedValue: guessed,
                method: 'Result-Set Mode',
                basisColumns: [c],
                confidence: 0.58,
                explanation: `Missing categorical value in ${c} approximated from result set.`,
              };
            }
          }
        }
        return next;
      });
    }

    const guessedCount = Object.values(markers).reduce((sum, m) => sum + Object.keys(m).length, 0);
    if (guessedCount > 0) {
      warnings.push(
        `${guessedCount} missing cell(s) in the query result were approximated using peer/column statistics and explicitly tagged as GUESSED · WAS MISSING.`
      );
    }

    return {
      columns: cols,
      rows,
      rowCount: rows.length,
      executionMs: Math.round((performance.now() - start) * 100) / 100,
      imputedCellMarkers: markers,
      resultAnomalies: warnings,
    };
  } catch (err) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionMs: Math.round((performance.now() - start) * 100) / 100,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function cleanSqlOutput(sql: string): string {
  let s = sql.trim();
  if (s.toLowerCase().startsWith('```sql')) s = s.slice(6).trim();
  else if (s.startsWith('```')) s = s.slice(3).trim();
  if (s.endsWith('```')) s = s.slice(0, -3).trim();
  return s.trim();
}

function safeJsonParse(raw: string | undefined): Record<string, unknown> {
  let txt = (raw ?? '{}').trim();
  if (txt.startsWith('```json')) txt = txt.slice(7).trim();
  else if (txt.startsWith('```')) txt = txt.slice(3).trim();
  if (txt.endsWith('```')) txt = txt.slice(0, -3).trim();
  try {
    const p = JSON.parse(txt);
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    // Fallback to outer braces extraction
  }
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const p = JSON.parse(txt.slice(start, end + 1));
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
  }
  throw new Error('Failed to parse structured JSON response from the configured LLM.');
}

const keyCooldowns = new Map<string, number>();

function slotIdentity(cfg: LlmConfigSlot): string {
  return `${cfg.slot}:${cfg.apiKey}`;
}

function cooldownMsForError(status: number, text: string): number {
  const low = text.toLowerCase();
  if (
    status === 429 ||
    ['rate_limit', 'rate limit', 'token', 'tpm', 'tpd', 'rpm'].some((t) => low.includes(t))
  ) {
    return 60_000;
  }
  if (
    [401, 402, 403].includes(status) ||
    ['quota', 'insufficient', 'invalid_api_key', 'billing'].some((t) => low.includes(t))
  ) {
    return 120_000;
  }
  return 20_000;
}

function orderSlotsByHealth(slots: LlmConfigSlot[]): LlmConfigSlot[] {
  const now = Date.now();
  const ready: LlmConfigSlot[] = [];
  const cooled: Array<{ until: number; cfg: LlmConfigSlot }> = [];
  for (const cfg of slots) {
    const until = keyCooldowns.get(slotIdentity(cfg)) ?? 0;
    if (until <= now) ready.push(cfg);
    else cooled.push({ until, cfg });
  }
  cooled.sort((a, b) => a.until - b.until);
  return [...ready, ...cooled.map((c) => c.cfg)];
}

async function callLlmStructuredWithMeta(
  systemInstruction: string,
  userPrompt: string,
  schemaHint: string
): Promise<{ parsed: Record<string, unknown>; meta: LlmFailoverMeta }> {
  const configs = resolveLlmConfigs();
  const orderedSlots = orderSlotsByHealth(configs);
  const singleKeyMode = orderedSlots.length === 1;
  const failovers: string[] = [];
  const errorsBySlot: string[] = [];

  const systemContent = `${systemInstruction}\n\nIMPORTANT: Respond ONLY with valid JSON matching this schema:\n${schemaHint}`;

  for (let slotIdx = 0; slotIdx < orderedSlots.length; slotIdx++) {
    const cfg = orderedSlots[slotIdx];
    const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
    const endpoint = cleanBase.endsWith('/chat/completions')
      ? cleanBase
      : `${cleanBase}/chat/completions`;

    const payload: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    };

    const maxAttempts = singleKeyMode ? 2 : 1;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutSec * 1000);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'GraphSQL-Studio/1.0',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
          if (resp.status === 400 && 'response_format' in payload && text.includes('response_format')) {
            delete payload.response_format;
            attempt--;
            continue;
          }
          if (singleKeyMode && [429, 502, 503, 504].includes(resp.status) && attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          keyCooldowns.set(slotIdentity(cfg), Date.now() + cooldownMsForError(resp.status, text));
          errorsBySlot.push(`Key #${cfg.slot} (${cfg.maskedKey}) [HTTP ${resp.status}: ${text.slice(0, 240)}]`);
          if (slotIdx < orderedSlots.length - 1) {
            const nextCfg = orderedSlots[slotIdx + 1];
            failovers.push(
              `Key #${cfg.slot} (${cfg.maskedKey}) hit HTTP ${resp.status} -> switched to Key #${nextCfg.slot} (${nextCfg.maskedKey})`
            );
          }
          break;
        }
        const outer = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        const content = outer.choices?.[0]?.message?.content;
        if (!content) throw new Error('Configured LLM endpoint returned no choices.');
        const parsed = safeJsonParse(content);
        keyCooldowns.delete(slotIdentity(cfg));
        return {
          parsed,
          meta: {
            keySlot: cfg.slot,
            maskedKey: cfg.maskedKey,
            model: cfg.model,
            totalKeysConfigured: configs.length,
            failovers,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (singleKeyMode && attempt < maxAttempts && /abort|timeout|network|ECONN/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        keyCooldowns.set(slotIdentity(cfg), Date.now() + 20_000);
        errorsBySlot.push(`Key #${cfg.slot} (${cfg.maskedKey}) [${msg.slice(0, 240)}]`);
        if (slotIdx < orderedSlots.length - 1) {
          const nextCfg = orderedSlots[slotIdx + 1];
          failovers.push(
            `Key #${cfg.slot} (${cfg.maskedKey}) error (${msg.slice(0, 80)}) -> switched to Key #${nextCfg.slot} (${nextCfg.maskedKey})`
          );
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw new Error(
    `All configured API keys failed (${orderedSlots.length} tried): ${errorsBySlot.join(' | ')}`
  );
}

function inspectSqlJsExplainPlan(db: Database, sql: string): string[] {
  const clean = sql.trim().replace(/;+$/, '');
  if (!clean) return [];
  const up = clean.trimStart().toUpperCase();
  if (!up.startsWith('SELECT') && !up.startsWith('WITH')) return [];
  try {
    const res = execRows(db, `EXPLAIN QUERY PLAN ${clean}`);
    return res.rows
      .map((r) => String(r.detail ?? Object.values(r).at(-1) ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatSchemaContext(profile: DataProfile): string {
  const tableLines = profile.tables.map((t) => {
    const colLines = t.columns.map((c) => {
      const flags: string[] = [];
      if (c.isPrimaryKey) flags.push('PK');
      if (c.isForeignKey && c.referencesTable) flags.push(`FK->${c.referencesTable}.${c.referencesColumn}`);
      if (c.missingCount > 0) flags.push(`missing:${c.missingCount}/${t.rowCount}`);
      if (c.anomalyCount > 0) flags.push(`anomalies:${c.anomalyCount}`);
      return `  - ${c.name} (${c.type}${flags.length ? `, ${flags.join(', ')}` : ''})`;
    });
    return `TABLE ${t.name} (${t.rowCount} rows):\n${colLines.join('\n')}`;
  });

  const edgeLines = profile.edges.map(
    (e) =>
      `EDGE [${e.id}]: ${e.fromTable}.${e.fromColumn} -> ${e.toTable}.${e.toColumn} | inferred=${e.inferred} | orphanCount=${e.orphanCount} | missingRate=${e.missingRate} | anomalyPenalty=${e.anomalyPenalty}`
  );

  const multiPathNotes: string[] = [];
  for (let i = 0; i < profile.tables.length; i++) {
    for (let j = i + 1; j < profile.tables.length; j++) {
      const a = profile.tables[i].name;
      const b = profile.tables[j].name;
      const paths = enumerateJoinPaths({ tables: profile.tables, edges: profile.edges }, a, b, 4);
      if (paths.length > 1) {
        const formatted = paths
          .slice(0, 3)
          .map(
            (p, idx) =>
              `Path ${idx + 1}: ${p.summary} (hops=${p.hopCount}, resilience=${p.resilienceScore}, anomalyPenalty=${p.anomalyPenalty})`
          )
          .join(' | ');
        multiPathNotes.push(`Routes ${a} <-> ${b}: ${formatted}`);
      }
    }
  }

  const anomalyNotes = profile.anomalies.length
    ? profile.anomalies.map((a) => `- [${a.severity.toUpperCase()}] ${a.tableName}.${a.columnName}: ${a.description}`).join('\n')
    : 'None detected.';

  return [
    '=== DATABASE SCHEMA ===',
    tableLines.join('\n\n'),
    '',
    '=== FOREIGN KEY GRAPH EDGES ===',
    edgeLines.length ? edgeLines.join('\n') : 'No explicit foreign key edges.',
    '',
    '=== MULTI-PATH GRAPH ROUTES ===',
    multiPathNotes.length ? multiPathNotes.join('\n') : 'Single unique path per table pair.',
    '',
    '=== DATA ANOMALIES & MISSINGNESS ===',
    anomalyNotes,
  ].join('\n');
}

async function repairSqlWithLlm(
  question: string,
  schemaContext: string,
  failedSql: string,
  sqliteError: string,
  retryNumber: number
): Promise<{ diagnosis: string; fixedSql: string; llmMeta: LlmFailoverMeta }> {
  const prompt = `${schemaContext}

ORIGINAL USER QUESTION: "${question}"
FAILING SQL (Retry ${retryNumber}/5):
${failedSql}

SQLITE EXECUTION ERROR:
${sqliteError}

Fix the SQLite query so it executes without error and accurately answers the question using only existing tables and columns.`;
  const { parsed, meta } = await callLlmStructuredWithMeta(
    'You are a SQLite SQL Self-Healing Repair module. Diagnose the exact SQLite error and return a valid, corrected SQLite SELECT query.',
    prompt,
    '{ "diagnosis": "string", "fixedSql": "string" }'
  );
  return {
    diagnosis: String(parsed.diagnosis || `Repair attempt ${retryNumber} applied.`),
    fixedSql: String(parsed.fixedSql || failedSql),
    llmMeta: meta,
  };
}

async function runTextOnlyGeneration(question: string) {
  const schemaHint =
    '{ "inferredDdl": "CREATE TABLE ...", "explanation": "string", "candidates": [{ "label": "string", "strategy": "string", "sql": "SELECT ...", "graphPathTables": ["TableA"], "semanticScore": 0.9, "rationale": "string" }] }';
  const initRes = await callLlmStructuredWithMeta(
    'You are GraphSQL running in Text-Only Schema-Free Mode. Infer normalized tables/foreign keys, produce clean ANSI/SQLite SQL queries, and explain the relational paths.',
    `User question (no database file provided): "${question}"\nInfer a clean, realistic relational SQLite schema (CREATE TABLE DDL) that supports this question, and generate 2 candidate SQL queries (e.g. Standard Aggregation vs CTE/Windowed Path) with an explanation.`,
    schemaHint
  );
  const parsed = initRes.parsed;
  let llmMeta: LlmFailoverMeta = initRes.meta;
  const allFailovers = [...llmMeta.failovers];

  const inferredDdl = String(parsed.inferredDdl || '');
  const explanation = String(parsed.explanation || '');
  const rawCands = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  const SQL = await getSqlJs();
  const tempDb = new SQL.Database();
  let syntaxValid = true;
  let syntaxError: string | null = null;
  let profile: DataProfile = {
    tables: [],
    edges: [],
    totalRows: 0,
    totalMissingCells: 0,
    totalAnomalies: 0,
    imputedCells: [],
    anomalies: [],
  };
  try {
    if (inferredDdl) {
      tempDb.exec(inferredDdl);
      profile = profileDatabase(tempDb);
    }
  } catch (err) {
    syntaxValid = false;
    syntaxError = err instanceof Error ? err.message : String(err);
  }

  const candidates: CandidatePathQuery[] = [];
  const repairAttempts: RepairAttempt[] = [];
  try {
    for (let i = 0; i < Math.min(3, rawCands.length); i++) {
      const c = rawCands[i] as Record<string, unknown>;
      let sql = cleanSqlOutput(String(c.sql || ''));
      let execRes: QueryExecutionResult = { columns: [], rows: [], rowCount: 0, executionMs: 0 };
      if (syntaxValid && profile.tables.length > 0) {
        execRes = executeReadOnlyOnDb(tempDb, sql, false);
      }

      if (i === 0) {
        repairAttempts.push({
          attemptNumber: 1,
          isInitial: true,
          sql,
          status: execRes.error ? 'error' : 'success',
          errorMessage: execRes.error,
          diagnosis: execRes.error
            ? `Validated against inferred DDL failed: ${execRes.error}`
            : 'Validated cleanly against inferred SQLite schema.',
          executionMs: execRes.executionMs,
        });
        let retries = 0;
        while (execRes.error && retries < 5 && syntaxValid) {
          retries++;
          const repaired = await repairSqlWithLlm(question, inferredDdl, sql, execRes.error, retries);
          allFailovers.push(...repaired.llmMeta.failovers);
          llmMeta = { ...repaired.llmMeta, failovers: allFailovers };
          sql = cleanSqlOutput(repaired.fixedSql);
          execRes = executeReadOnlyOnDb(tempDb, sql, false);
          repairAttempts.push({
            attemptNumber: 1 + retries,
            isInitial: false,
            sql,
            status: execRes.error ? 'error' : 'success',
            errorMessage: execRes.error,
            diagnosis: repaired.diagnosis,
            executionMs: execRes.executionMs,
          });
        }
      }

      const plan = parseSqlToQueryGraph(sql, profile.tables, profile.edges);
      const explainSteps =
        syntaxValid && !execRes.error ? inspectSqlJsExplainPlan(tempDb, sql) : [];
      const sem = Math.round(Math.max(0.1, Math.min(1, Number(c.semanticScore || 0.85))) * 1000) / 1000;
      const costBreakdown = calculateQueryCost({
        tables: profile.tables,
        usedTables: plan.usedTables,
        hopCount: plan.usedEdgeIds.length,
        anomalyPenalty: 0,
        nullLossRate: 0,
        semanticScore: sem,
        executionMs: execRes.executionMs,
        hasError: Boolean(execRes.error),
        explainSteps,
      });
      const rationale = String(c.rationale || '');
      candidates.push({
        id: `txt_cand_${i + 1}`,
        label: String(c.label || `Candidate ${i + 1}`),
        strategy: String(c.strategy || 'Schema-Free Synthesis'),
        sql,
        graphPathTables: plan.usedTables.length ? plan.usedTables : (Array.isArray(c.graphPathTables) ? (c.graphPathTables as string[]) : []),
        graphPathEdges: plan.usedEdgeIds,
        usedColumns: plan.usedColumns,
        hopCount: plan.usedEdgeIds.length,
        semanticScore: sem,
        anomalyPenalty: 0,
        nullLossRate: 0,
        resilienceScore: sem,
        queryCost: costBreakdown.totalCost,
        costBreakdown,
        selected: false,
        selectionReason: rationale,
        execution: execRes,
      });
    }
  } finally {
    tempDb.close();
  }

  let winner: CandidatePathQuery | null = null;
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const ca = a.queryCost ?? 0;
      const cb = b.queryCost ?? 0;
      if (ca !== cb) return ca - cb;
      return b.resilienceScore - a.resilienceScore;
    });
    winner = candidates[0];
    winner.selected = true;
    winner.selectionReason = `Selected Lowest-Cost Query (Cost ${winner.queryCost}): ${winner.selectionReason}`;
    for (const alt of candidates.slice(1)) {
      alt.selected = false;
      if (alt.execution.error) {
        alt.selectionReason = `Not Selected — Execution failed (${alt.execution.error}).`;
      } else {
        const delta = Math.round(((alt.queryCost ?? 0) - (winner.queryCost ?? 0)) * 100) / 100;
        alt.selectionReason = `Not Selected — Higher query cost (${alt.queryCost} vs ${winner.queryCost}, +${delta}).`;
      }
    }
  }

  const queryGraph = parseSqlToQueryGraph(winner?.sql ?? '', profile.tables, profile.edges);
  llmMeta.failovers = allFailovers;
  return {
    mode: 'text_only' as const,
    question,
    inferredDdl,
    selectedSql: winner?.sql ?? '',
    explanation,
    candidates,
    repairAttempts,
    totalAttempts: repairAttempts.length,
    healedOnRetry: repairAttempts.length > 1 && repairAttempts[repairAttempts.length - 1].status === 'success',
    queryGraph,
    result: winner?.execution ?? { columns: [], rows: [], rowCount: 0, executionMs: 0 },
    dataWarnings: syntaxError
      ? [`Inferred schema note: ${syntaxError}`]
      : [
          'Text-Only Mode: SQL generated from natural language and syntax-verified against inferred DDL (no .db/.sql data rows loaded).',
        ],
    llmMeta,
  };
}

async function generateAndRunTextToSqlOnBytes(
  question: string,
  dbBytes: Uint8Array | null,
  forceTextOnly = false,
  maxCandidates = 3,
  applyImputationOverlay = true
) {
  if (!dbBytes || forceTextOnly) {
    return runTextOnlyGeneration(question);
  }

  const db = await openSessionDb(dbBytes);
  try {
    const profile = profileDatabase(db);
    const schemaContext = formatSchemaContext(profile);
    const multiRule =
      maxCandidates === 1
        ? '1 optimal SQLite SELECT query'
        : '2 to 3 distinct SQLite SELECT candidate queries representing different graph join paths or anomaly-defensive strategies';

    const initRes = await callLlmStructuredWithMeta(
      `You are GraphSQL, an Anomaly-Aware Multi-Path Text-to-SQL engine targeting SQLite.
Given a user question, a relational schema graph with edge anomaly penalties, and missing-value statistics:
1. Generate ${multiRule}.
2. Always use exact table and column names from the schema. Never invent columns.
3. For each candidate, specify graphPathTables, strategy label, semanticScore (0.0-1.0), and rationale.
4. Put your strongest recommended SQL query first.`,
      `${schemaContext}\n\nUSER QUESTION: "${question}"\n\nGenerate candidate SQLite SELECT queries with multi-path graph traces.`,
      '{ "explanation": "string", "candidates": [{ "label": "string", "strategy": "string", "sql": "SELECT ...", "graphPathTables": ["TableA"], "semanticScore": 0.9, "rationale": "string" }] }'
    );
    const parsed = initRes.parsed;
    let llmMeta: LlmFailoverMeta = initRes.meta;
    const allFailovers = [...llmMeta.failovers];

    let rawCands = (Array.isArray(parsed.candidates) ? parsed.candidates : []) as Record<string, unknown>[];
    if (!rawCands.length) {
      const firstTbl = profile.tables[0]?.name ?? 'sqlite_master';
      rawCands = [
        {
          label: 'Primary Query',
          strategy: 'Direct Schema Projection',
          sql: `SELECT * FROM ${quoteIdent(firstTbl)} LIMIT 10;`,
          graphPathTables: profile.tables.length ? [firstTbl] : [],
          semanticScore: 0.7,
          rationale: 'Fallback query generated when candidate array was empty.',
        },
      ];
    }
    rawCands = rawCands.slice(0, maxCandidates);

    const repairAttempts: RepairAttempt[] = [];
    const evaluated: CandidatePathQuery[] = [];

    for (let idx = 0; idx < rawCands.length; idx++) {
      const raw = rawCands[idx];
      let currentSql = cleanSqlOutput(String(raw.sql || ''));
      let execRes = executeReadOnlyOnDb(db, currentSql, applyImputationOverlay);

      if (idx === 0) {
        repairAttempts.push({
          attemptNumber: 1,
          isInitial: true,
          sql: currentSql,
          status: execRes.error ? 'error' : 'success',
          errorMessage: execRes.error,
          diagnosis: execRes.error
            ? `Initial execution failed: ${execRes.error}`
            : 'Initial candidate executed cleanly on SQLite.',
          executionMs: execRes.executionMs,
        });

        let retryCount = 0;
        while (execRes.error && retryCount < 5) {
          retryCount++;
          const repaired = await repairSqlWithLlm(
            question,
            schemaContext,
            currentSql,
            execRes.error,
            retryCount
          );
          allFailovers.push(...repaired.llmMeta.failovers);
          llmMeta = { ...repaired.llmMeta, failovers: allFailovers };
          currentSql = cleanSqlOutput(repaired.fixedSql);
          execRes = executeReadOnlyOnDb(db, currentSql, applyImputationOverlay);
          repairAttempts.push({
            attemptNumber: 1 + retryCount,
            isInitial: false,
            sql: currentSql,
            status: execRes.error ? 'error' : 'success',
            errorMessage: execRes.error,
            diagnosis: repaired.diagnosis,
            executionMs: execRes.executionMs,
          });
        }
      }

      const plan = parseSqlToQueryGraph(currentSql, profile.tables, profile.edges);
      const hopCount = plan.usedEdgeIds.length;
      const usedSet = new Set(plan.usedEdgeIds);
      const anomalyPenalty =
        Math.round(
          profile.edges
            .filter((e) => usedSet.has(e.id))
            .reduce((s, e) => s + e.anomalyPenalty, 0) * 1000
        ) / 1000;
      const totalCells = Math.max(1, execRes.rows.length * Math.max(1, execRes.columns.length));
      const imputedInRes = Object.values(execRes.imputedCellMarkers ?? {}).reduce(
        (sum, m) => sum + Object.keys(m).length,
        0
      );
      const nullLossRate = Math.round((imputedInRes / totalCells) * 1000) / 1000;
      const semScore = Math.max(0.1, Math.min(1.0, Number(raw.semanticScore || 0.8)));
      const execBonus = execRes.error ? -0.85 : 0.25;
      const rowBonus = !execRes.error && execRes.rowCount > 0 ? 0.1 : 0;
      const rawResilience =
        0.48 * semScore +
        0.22 * (1 / (1 + 0.25 * Math.max(0, hopCount - 1))) +
        execBonus +
        rowBonus -
        0.38 * anomalyPenalty -
        0.2 * nullLossRate;
      const resilienceScore = Math.round(Math.max(0.01, Math.min(0.99, rawResilience)) * 1000) / 1000;
      const explainSteps = !execRes.error ? inspectSqlJsExplainPlan(db, currentSql) : [];
      const costBreakdown = calculateQueryCost({
        tables: profile.tables,
        usedTables: plan.usedTables,
        hopCount,
        anomalyPenalty,
        nullLossRate,
        semanticScore: semScore,
        executionMs: execRes.executionMs,
        hasError: Boolean(execRes.error),
        explainSteps,
      });

      evaluated.push({
        id: `cand_${idx + 1}`,
        label: String(raw.label || `Candidate ${idx + 1}`),
        strategy: String(raw.strategy || 'Graph Path'),
        sql: currentSql,
        graphPathTables: plan.usedTables.length
          ? plan.usedTables
          : Array.isArray(raw.graphPathTables)
            ? (raw.graphPathTables as string[])
            : [],
        graphPathEdges: plan.usedEdgeIds,
        usedColumns: plan.usedColumns,
        hopCount,
        semanticScore: Math.round(semScore * 1000) / 1000,
        anomalyPenalty,
        nullLossRate,
        resilienceScore,
        queryCost: costBreakdown.totalCost,
        costBreakdown,
        selected: false,
        selectionReason: String(raw.rationale || ''),
        execution: execRes,
      });
    }

    evaluated.sort((a, b) => {
      const okA = a.execution.error ? 1 : 0;
      const okB = b.execution.error ? 1 : 0;
      if (okA !== okB) return okA - okB;
      const ca = a.queryCost ?? 0;
      const cb = b.queryCost ?? 0;
      if (ca !== cb) return ca - cb;
      return b.resilienceScore - a.resilienceScore;
    });

    const winner = evaluated[0];
    winner.selected = true;
    winner.selectionReason = `Selected Lowest-Cost Query (Cost ${winner.queryCost} · Resilience ${winner.resilienceScore}): ${winner.selectionReason}`;

    for (const alt of evaluated.slice(1)) {
      alt.selected = false;
      if (alt.execution.error) {
        alt.selectionReason = `Not Selected — Execution failed (${alt.execution.error}).`;
      } else {
        const delta = Math.round(((alt.queryCost ?? 0) - (winner.queryCost ?? 0)) * 100) / 100;
        if (alt.anomalyPenalty > winner.anomalyPenalty) {
          alt.selectionReason = `Not Selected — Higher query cost (${alt.queryCost} vs ${winner.queryCost}, +${delta}) due to graph edge anomaly penalty (${alt.anomalyPenalty} vs ${winner.anomalyPenalty}).`;
        } else {
          alt.selectionReason = `Not Selected — Higher calculated query cost (${alt.queryCost} vs ${winner.queryCost}, +${delta}).`;
        }
      }
    }

    const winningPlan = parseSqlToQueryGraph(winner.sql, profile.tables, profile.edges);
    const dataWarnings: string[] = [...(winner.execution.resultAnomalies ?? [])];
    if (profile.totalAnomalies > 0) {
      dataWarnings.push(
        `${profile.totalAnomalies} active schema/data anomalies detected in database; cost model penalized corrupted edges.`
      );
    }

    llmMeta.failovers = allFailovers;
    return {
      mode: 'database' as const,
      question,
      selectedSql: winner.sql,
      explanation: String(parsed.explanation || winner.selectionReason),
      candidates: evaluated,
      repairAttempts,
      totalAttempts: repairAttempts.length,
      healedOnRetry:
        repairAttempts.length > 1 && repairAttempts[repairAttempts.length - 1].status === 'success',
      queryGraph: winningPlan,
      result: winner.execution,
      dataWarnings,
      llmMeta,
    };
  } finally {
    db.close();
  }
}

// Spider Dev Dataset support
interface InternalSpiderTask extends SpiderTask {
  dbPath: string;
}

function resolveSpiderDir(): string {
  const dotenv = readDotenvMap();
  const configured = dotenv.SPIDER_DATA_DIR || process.env.SPIDER_DATA_DIR || 'data/spider';
  for (const cand of [configured, 'data/spider', 'data/spider_data']) {
    if (fs.existsSync(path.join(cand, 'dev.json')) && fs.existsSync(path.join(cand, 'database'))) {
      return cand;
    }
  }
  return configured;
}

function classifySpiderHardness(item: Record<string, unknown>): SpiderHardness {
  const queryStr = String(item.query || '').toUpperCase();
  const sqlAst = item.sql as Record<string, unknown> | undefined;
  if (sqlAst && typeof sqlAst === 'object') {
    if (sqlAst.intersect || sqlAst.union || sqlAst.except) return 'Extra Hard';
    const fromPart = (sqlAst.from as Record<string, unknown> | undefined) ?? {};
    const tableUnits = (Array.isArray(fromPart.table_units) ? fromPart.table_units : []) as unknown[];
    if (tableUnits.length >= 4) return 'Extra Hard';
    const whereLen = Array.isArray(sqlAst.where) ? sqlAst.where.length : 0;
    const hasGroup = Array.isArray(sqlAst.groupBy) && sqlAst.groupBy.length > 0;
    const hasHaving = Array.isArray(sqlAst.having) && sqlAst.having.length > 0;
    const complexity = (tableUnits.length - 1) * 2 + (hasGroup ? 1 : 0) + (hasHaving ? 2 : 0) + whereLen;
    if (complexity >= 5) return 'Hard';
    if (complexity >= 2) return 'Medium';
    return 'Easy';
  }
  if (/INTERSECT|UNION|EXCEPT/.test(queryStr) || queryStr.split('SELECT').length > 2) return 'Extra Hard';
  if ((queryStr.match(/\bJOIN\b/g)?.length ?? 0) >= 2 || queryStr.includes('HAVING')) return 'Hard';
  if (/GROUP BY|ORDER BY|\bJOIN\b/.test(queryStr)) return 'Medium';
  return 'Easy';
}

let spiderCache: { dir: string; tasks: InternalSpiderTask[]; dbCount: number } | null = null;
function loadSpiderTasks(): { tasks: InternalSpiderTask[]; dbCount: number; dir: string } {
  const dir = resolveSpiderDir();
  if (spiderCache && spiderCache.dir === dir) {
    return { tasks: spiderCache.tasks, dbCount: spiderCache.dbCount, dir };
  }
  const devFile = path.join(dir, 'dev.json');
  const dbRoot = path.join(dir, 'database');
  if (!fs.existsSync(devFile) || !fs.existsSync(dbRoot)) {
    return { tasks: [], dbCount: 0, dir };
  }
  const raw = JSON.parse(fs.readFileSync(devFile, 'utf-8')) as Record<string, unknown>[];
  const tasks: InternalSpiderTask[] = [];
  const dbs = new Set<string>();
  raw.forEach((item, idx) => {
    const dbId = String(item.db_id || '').trim();
    const sqlitePath = path.join(dbRoot, dbId, `${dbId}.sqlite`);
    if (!dbId || !fs.existsSync(sqlitePath)) return;
    dbs.add(dbId);
    tasks.push({
      id: `spider_dev_${String(idx + 1).padStart(4, '0')}`,
      dbId,
      dbName: dbId,
      hardness: classifySpiderHardness(item),
      question: String(item.question || '').trim(),
      goldSql: String(item.query || '').trim(),
      dbPath: sqlitePath,
    });
  });
  spiderCache = { dir, tasks, dbCount: dbs.size };
  return { tasks, dbCount: dbs.size, dir };
}

function getSpiderDatasetInfoNode(): SpiderDatasetInfo {
  const { tasks, dbCount, dir } = loadSpiderTasks();
  const hardnessCounts: Record<SpiderHardness, number> = {
    Easy: 0,
    Medium: 0,
    Hard: 0,
    'Extra Hard': 0,
  };
  for (const t of tasks) hardnessCounts[t.hardness]++;
  return {
    downloaded: tasks.length > 0,
    datasetDir: dir,
    datasetName: 'Official Yale Spider 1.0 Dev Split (dev.json + SQLite DBs)',
    totalTasks: tasks.length,
    totalDatabases: dbCount,
    hardnessCounts,
    previewTasks: tasks.slice(0, 60).map(({ dbPath: _unused, ...rest }) => rest),
  };
}

let spiderJob: SpiderJobStatus = {
  jobId: null,
  status: 'idle',
  completed: 0,
  total: 0,
  error: null,
  summary: null,
};
let cancelRequested = false;

function buildSpiderSummary(
  total: number,
  results: SpiderTaskResult[],
  failoverEvents: string[] = []
): SpiderBenchmarkSummary {
  const executed = results.length;
  const exPassed = results.filter((r) => r.executionMatch).length;
  const firstPass = results.filter((r) => r.executionMatch && r.attemptsUsed === 1).length;
  const healed = results.filter((r) => r.executionMatch && r.healedOnRetry).length;
  const avgF1 = executed ? Math.round((results.reduce((s, r) => s + r.componentMatchF1, 0) / executed) * 1000) / 1000 : 0;
  const avgLatency = executed ? Math.round((results.reduce((s, r) => s + r.executionMs, 0) / executed) * 10) / 10 : 0;
  const costs = results.map((r) => r.queryCost).filter((c): c is number => typeof c === 'number');
  const avgQueryCost = costs.length
    ? Math.round((costs.reduce((s, c) => s + c, 0) / costs.length) * 100) / 100
    : 0;

  const byHardness: SpiderBenchmarkSummary['byHardness'] = {
    Easy: { total: 0, passed: 0, accuracy: 0 },
    Medium: { total: 0, passed: 0, accuracy: 0 },
    Hard: { total: 0, passed: 0, accuracy: 0 },
    'Extra Hard': { total: 0, passed: 0, accuracy: 0 },
  };
  for (const r of results) {
    byHardness[r.hardness].total++;
    if (r.executionMatch) byHardness[r.hardness].passed++;
  }
  for (const h of ['Easy', 'Medium', 'Hard', 'Extra Hard'] as SpiderHardness[]) {
    const b = byHardness[h];
    b.accuracy = b.total ? Math.round((b.passed / b.total) * 1000) / 10 : 0;
  }

  return {
    totalTasks: total,
    executedTasks: executed,
    executionAccuracy: executed ? Math.round((exPassed / executed) * 1000) / 10 : 0,
    firstPassAccuracy: executed ? Math.round((firstPass / executed) * 1000) / 10 : 0,
    healedAccuracy: executed ? Math.round((healed / executed) * 1000) / 10 : 0,
    avgComponentF1: avgF1,
    avgLatencyMs: avgLatency,
    avgQueryCost,
    failoverEvents,
    byHardness,
    results,
  };
}

async function runSpiderJob(selected: InternalSpiderTask[]) {
  const results: SpiderTaskResult[] = [];
  const failoverSet = new Set<string>();
  const failoverEvents: string[] = [];
  try {
    const configs = resolveLlmConfigs();
    spiderJob = {
      ...spiderJob,
      activeKeySlot: configs[0].slot,
      configuredKeys: configs.length,
      failoverEvents: [],
    };
    for (const task of selected) {
      if (cancelRequested) {
        spiderJob = {
          ...spiderJob,
          status: 'cancelled',
          completed: results.length,
          failoverEvents: [...failoverEvents],
          summary: buildSpiderSummary(selected.length, [...results], [...failoverEvents]),
        };
        return;
      }
      const start = performance.now();
      const dbBytes = new Uint8Array(fs.readFileSync(task.dbPath));
      const goldDb = await openSessionDb(dbBytes);
      let goldRes: QueryExecutionResult;
      try {
        goldRes = executeReadOnlyOnDb(goldDb, task.goldSql, false);
      } finally {
        goldDb.close();
      }

      try {
        const gen = await generateAndRunTextToSqlOnBytes(task.question, dbBytes, false, 2, false);
        const predRes = gen.result;
        const orderSensitive = task.goldSql.toUpperCase().includes('ORDER BY');
        const matched =
          !goldRes.error &&
          !predRes.error &&
          compareExecutionResults(goldRes, predRes, orderSensitive);
        const f1 = computeComponentMatchF1(task.goldSql, gen.selectedSql);
        const winner = gen.candidates.find((c) => c.selected) ?? gen.candidates[0];
        for (const ev of gen.llmMeta?.failovers ?? []) {
          if (!failoverSet.has(ev)) {
            failoverSet.add(ev);
            failoverEvents.push(ev);
          }
        }
        results.push({
          taskId: task.id,
          dbId: task.dbId,
          hardness: task.hardness,
          question: task.question,
          goldSql: task.goldSql,
          predictedSql: gen.selectedSql,
          executionMatch: matched,
          componentMatchF1: f1,
          attemptsUsed: gen.totalAttempts,
          healedOnRetry: gen.healedOnRetry,
          executionMs: Math.round((performance.now() - start) * 10) / 10,
          goldRowCount: goldRes.rowCount,
          predictedRowCount: predRes.rowCount,
          queryCost: winner?.queryCost,
          keySlot: gen.llmMeta?.keySlot ?? 1,
          error: predRes.error,
        });
        if (gen.llmMeta?.keySlot) {
          spiderJob.activeKeySlot = gen.llmMeta.keySlot;
        }
      } catch (err) {
        results.push({
          taskId: task.id,
          dbId: task.dbId,
          hardness: task.hardness,
          question: task.question,
          goldSql: task.goldSql,
          predictedSql: '',
          executionMatch: false,
          componentMatchF1: 0,
          attemptsUsed: 1,
          healedOnRetry: false,
          executionMs: Math.round((performance.now() - start) * 10) / 10,
          goldRowCount: goldRes.rowCount,
          predictedRowCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      spiderJob = {
        ...spiderJob,
        completed: results.length,
        failoverEvents: [...failoverEvents],
        summary: buildSpiderSummary(selected.length, [...results], [...failoverEvents]),
      };
    }
    spiderJob = {
      ...spiderJob,
      status: 'completed',
      completed: results.length,
      failoverEvents: [...failoverEvents],
      summary: buildSpiderSummary(selected.length, results, [...failoverEvents]),
    };
  } catch (err) {
    spiderJob = {
      ...spiderJob,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createNodeBackendRouter(): Router {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

  router.use((req, res, next) => {
    if (req.path === '/db/upload') return next();
    express.json({ limit: '10mb' })(req, res, next);
  });

  router.get('/health', (_req: Request, res: Response) => {
    const info = getSpiderDatasetInfoNode();
    let configuredKeys = 0;
    try {
      configuredKeys = resolveLlmConfigs().length;
    } catch {
      configuredKeys = 0;
    }
    res.json({
      ok: true,
      backend: 'node-sqljs',
      nodeVersion: process.version,
      llmConfigured: configuredKeys > 0,
      configuredKeys,
      spiderDatasetReady: info.downloaded,
      spiderTotalTasks: info.totalTasks,
    });
  });

  router.get('/examples', (_req: Request, res: Response) => {
    res.json({
      examples: SHOWCASE_EXAMPLES.map(({ sqlSeed: _ignored, ...rest }) => rest),
    });
  });

  router.get('/db/state', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      let profile: DataProfile | null = null;
      if (sess.dbBytes) {
        const db = await openSessionDb(sess.dbBytes);
        try {
          profile = profileDatabase(db);
        } finally {
          db.close();
        }
      }
      res.json({
        mode: sess.mode,
        sourceName: sess.sourceName,
        sourceKind: sess.sourceKind,
        exampleId: sess.exampleId,
        profile,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/db/table/:tableName', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      if (!sess.dbBytes) {
        res.status(400).json({ error: 'No database is currently loaded (Text-Only Mode).' });
        return;
      }
      const tableName = String(req.params.tableName);
      const db = await openSessionDb(sess.dbBytes);
      try {
        const profile = profileDatabase(db);
        const tableMeta = profile.tables.find((t) => t.name === tableName);
        if (!tableMeta) {
          res.status(404).json({ error: `Table "${tableName}" not found.` });
          return;
        }
        const pk = tableMeta.columns.find((c) => c.isPrimaryKey)?.name;
        const rowsRes = execRows(db, `SELECT * FROM ${quoteIdent(tableName)} LIMIT 250;`);
        const { imputedRows, imputedCells } = imputeMissingValues(
          tableName,
          rowsRes.rows,
          tableMeta.columns,
          pk
        );
        const cellMarkers: Record<string, Record<string, ImputedCellMeta>> = {};
        for (const ic of imputedCells) {
          cellMarkers[String(ic.rowIndex)] = cellMarkers[String(ic.rowIndex)] ?? {};
          cellMarkers[String(ic.rowIndex)][ic.columnName] = ic;
        }
        res.json({
          tableName,
          columns: tableMeta.columns,
          originalRows: rowsRes.rows,
          imputedRows,
          imputedCells,
          cellMarkers,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/load-example', async (req: Request, res: Response) => {
    try {
      const exampleId = String(req.body?.exampleId || 'ecommerce_multipath');
      const sess = await createExampleSession(getSessionId(req), exampleId);
      let profile: DataProfile | null = null;
      if (sess.dbBytes) {
        const db = await openSessionDb(sess.dbBytes);
        try {
          profile = profileDatabase(db);
        } finally {
          db.close();
        }
      }
      res.json({
        mode: sess.mode,
        sourceName: sess.sourceName,
        sourceKind: sess.sourceKind,
        exampleId: sess.exampleId,
        profile,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/text-only', (req: Request, res: Response) => {
    const sid = getSessionId(req);
    const sess: NodeSession = {
      sessionId: sid,
      mode: 'text_only',
      sourceName: 'Text-Only Mode (No DB Attached)',
      sourceKind: 'text_only',
      exampleId: 'text_only_mode',
      dbBytes: null,
      snapshotBytes: null,
    };
    sessions.set(sid, sess);
    res.json({
      mode: sess.mode,
      sourceName: sess.sourceName,
      sourceKind: sess.sourceKind,
      exampleId: sess.exampleId,
      profile: null,
    });
  });

  router.post('/db/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No .sql or .db file uploaded.' });
        return;
      }
      const sid = getSessionId(req);
      const name = file.originalname || 'uploaded.db';
      const lower = name.toLowerCase();
      const SQL = await getSqlJs();
      let db: Database;
      let kind: 'sql_file' | 'db_file';
      if (lower.endsWith('.sql')) {
        db = new SQL.Database();
        db.exec(file.buffer.toString('utf-8'));
        kind = 'sql_file';
      } else if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) {
        db = new SQL.Database(new Uint8Array(file.buffer));
        kind = 'db_file';
      } else {
        res.status(400).json({ error: 'Unsupported file type. Upload .sql, .db, .sqlite, or .sqlite3.' });
        return;
      }

      try {
        const exported = new Uint8Array(db.export());
        const profile = profileDatabase(db);
        const sess: NodeSession = {
          sessionId: sid,
          mode: 'database',
          sourceName: name,
          sourceKind: kind,
          exampleId: null,
          dbBytes: exported,
          snapshotBytes: new Uint8Array(exported),
        };
        sessions.set(sid, sess);
        res.json({
          mode: sess.mode,
          sourceName: sess.sourceName,
          sourceKind: sess.sourceKind,
          profile,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/reset', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      if (sess.snapshotBytes) {
        sess.dbBytes = new Uint8Array(sess.snapshotBytes);
      }
      let profile: DataProfile | null = null;
      if (sess.dbBytes) {
        const db = await openSessionDb(sess.dbBytes);
        try {
          profile = profileDatabase(db);
        } finally {
          db.close();
        }
      }
      res.json({
        mode: sess.mode,
        sourceName: sess.sourceName,
        sourceKind: sess.sourceKind,
        exampleId: sess.exampleId,
        profile,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/clean-anomaly', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      if (!sess.dbBytes) {
        res.status(400).json({ error: 'No database loaded.' });
        return;
      }
      const anomalyId = String(req.body?.anomalyId || '');
      const actionType = req.body?.actionType ? String(req.body.actionType).trim() : undefined;
      const customInstruction = req.body?.customInstruction
        ? String(req.body.customInstruction).trim()
        : undefined;
      if (!anomalyId) {
        res.status(400).json({ error: 'Missing anomalyId.' });
        return;
      }
      const db = await openSessionDb(sess.dbBytes);
      try {
        const outcome = await cleanAnomalyOnDb(db, anomalyId, actionType, customInstruction);
        sess.dbBytes = new Uint8Array(db.export());
        const profile = profileDatabase(db);
        res.json({ ...outcome, profile });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/clean-custom', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      if (!sess.dbBytes) {
        res.status(400).json({ error: 'No database loaded.' });
        return;
      }
      const tableName = String(req.body?.tableName || '').trim();
      const columnName = String(req.body?.columnName || '').trim();
      const instruction = String(req.body?.instruction || '').trim();
      if (!tableName || !columnName || !instruction) {
        res.status(400).json({
          error: 'Please select a table, select a column, and enter an instruction.',
        });
        return;
      }
      const db = await openSessionDb(sess.dbBytes);
      try {
        const outcome = await applyGeneralLanguageCleaningOnDb(db, tableName, columnName, instruction);
        sess.dbBytes = new Uint8Array(db.export());
        const profile = profileDatabase(db);
        res.json({ ...outcome, profile });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/db/clean-all', async (req: Request, res: Response) => {
    try {
      const sess = await getOrCreateSession(getSessionId(req));
      if (!sess.dbBytes) {
        res.status(400).json({ error: 'No database loaded.' });
        return;
      }
      const db = await openSessionDb(sess.dbBytes);
      try {
        const initial = profileDatabase(db);
        const appliedLog: Array<{ id: string; appliedSql: string; message: string; actionSummary: string }> = [];
        for (const a of initial.anomalies) {
          const outcome = await cleanAnomalyOnDb(db, a.id);
          appliedLog.push({ id: a.id, ...outcome });
        }
        sess.dbBytes = new Uint8Array(db.export());
        const profile = profileDatabase(db);
        res.json({ appliedLog, profile });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/sql/generate', async (req: Request, res: Response) => {
    try {
      const question = String(req.body?.question || '').trim();
      if (!question) {
        res.status(400).json({ error: 'Please provide a natural-language question.' });
        return;
      }
      const forceTextOnly = Boolean(req.body?.forceTextOnly);
      const sess = await getOrCreateSession(getSessionId(req));
      const result = await generateAndRunTextToSqlOnBytes(question, sess.dbBytes, forceTextOnly);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/sql/execute', async (req: Request, res: Response) => {
    try {
      const sql = String(req.body?.sql || '').trim();
      if (!sql) {
        res.status(400).json({ error: 'SQL query cannot be empty.' });
        return;
      }
      const sess = await getOrCreateSession(getSessionId(req));
      if (!sess.dbBytes) {
        res.json({
          execution: { columns: [], rows: [], rowCount: 0, executionMs: 0 },
          queryGraph: parseSqlToQueryGraph(sql, [], []),
        });
        return;
      }
      const db = await openSessionDb(sess.dbBytes);
      try {
        const profile = profileDatabase(db);
        const execution = executeReadOnlyOnDb(db, sql, true);
        const queryGraph = parseSqlToQueryGraph(sql, profile.tables, profile.edges);
        res.json({ execution, queryGraph });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/spider/info', (_req: Request, res: Response) => {
    res.json(getSpiderDatasetInfoNode());
  });

  router.get('/spider/tasks', (req: Request, res: Response) => {
    const hardnessQ = String(req.query.hardness || 'All').trim();
    const searchQ = String(req.query.search || '').trim().toLowerCase();
    const rawPage = Number(req.query.page || 1);
    const rawSize = Number(req.query.pageSize || 25);
    const pageNum = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(100, Math.floor(rawSize)) : 25;

    const { tasks } = loadSpiderTasks();
    let filtered = tasks;
    if (['Easy', 'Medium', 'Hard', 'Extra Hard'].includes(hardnessQ)) {
      filtered = filtered.filter((t) => t.hardness === hardnessQ);
    }
    if (searchQ) {
      filtered = filtered.filter(
        (t) =>
          t.question.toLowerCase().includes(searchQ) ||
          t.dbId.toLowerCase().includes(searchQ) ||
          t.id.toLowerCase().includes(searchQ) ||
          t.goldSql.toLowerCase().includes(searchQ)
      );
    }

    const filteredTotal = filtered.length;
    const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
    const safePage = Math.min(pageNum, totalPages);
    const startIdx = (safePage - 1) * pageSize;
    const slice = filtered.slice(startIdx, startIdx + pageSize);

    res.json({
      tasks: slice.map(({ dbPath: _unused, ...rest }) => rest),
      totalAvailable: tasks.length,
      filteredTotal,
      page: safePage,
      pageSize,
      totalPages,
    });
  });

  router.post('/spider/download', (_req: Request, res: Response) => {
    res.json(getSpiderDatasetInfoNode());
  });

  router.get('/spider/status', (_req: Request, res: Response) => {
    res.json(spiderJob);
  });

  router.post('/spider/cancel', (_req: Request, res: Response) => {
    cancelRequested = true;
    spiderJob = { ...spiderJob, status: 'cancelled' };
    res.json(spiderJob);
  });

  router.post('/spider/start', (req: Request, res: Response) => {
    if (spiderJob.status === 'running') {
      res.json(spiderJob);
      return;
    }
    try {
      resolveLlmConfig();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const { tasks } = loadSpiderTasks();
    if (!tasks.length) {
      res.status(400).json({ error: 'Official Spider dataset is not found in data/spider.' });
      return;
    }

    const hardness = String(req.body?.hardness || 'All');
    const offset = Math.max(0, Number(req.body?.offset || 0));
    const count = req.body?.count != null ? Number(req.body.count) : null;
    const taskIds = Array.isArray(req.body?.taskIds) ? new Set(req.body.taskIds.map(String)) : null;

    let pool = tasks;
    if (taskIds && taskIds.size > 0) {
      pool = tasks.filter((t) => taskIds.has(t.id));
    } else {
      if (['Easy', 'Medium', 'Hard', 'Extra Hard'].includes(hardness)) {
        pool = tasks.filter((t) => t.hardness === hardness);
      }
      if (offset > 0) pool = pool.slice(offset);
      if (count !== null && Number.isFinite(count) && count > 0) pool = pool.slice(0, count);
    }

    cancelRequested = false;
    spiderJob = {
      jobId: `spider_${Date.now()}`,
      status: 'running',
      completed: 0,
      total: pool.length,
      error: null,
      summary: null,
    };
    void runSpiderJob(pool);
    res.json(spiderJob);
  });

  return router;
}
