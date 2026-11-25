import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQueryCost, enumerateJoinPaths, parseSqlToQueryGraph } from './graphEngine.ts';
import {
  detectCasingAndWhitespaceAnomalies,
  detectNumericOutliers,
  imputeMissingValues,
  isMissingValue,
} from './dataQuality.ts';
import { compareExecutionResults, computeComponentMatchF1 } from './spiderComparator.ts';
import type { ColumnSchema, ForeignKeyEdge, TableSchema } from './types.ts';

test('enumerateJoinPaths prefers clean resilient path over high-anomaly shortcut', () => {
  const tables: TableSchema[] = [
    { name: 'Orders', rowCount: 20, columns: [] },
    { name: 'Invoices', rowCount: 20, columns: [] },
    { name: 'Customers', rowCount: 10, columns: [] },
    { name: 'LegacyBridge', rowCount: 20, columns: [] },
  ];

  const edges: ForeignKeyEdge[] = [
    {
      id: 'e_dirty',
      fromTable: 'Orders',
      fromColumn: 'legacy_cust_id',
      toTable: 'Customers',
      toColumn: 'customer_id',
      inferred: true,
      orphanCount: 6,
      missingRate: 0.45,
      anomalyPenalty: 0.75,
    },
    {
      id: 'e_clean_1',
      fromTable: 'Orders',
      fromColumn: 'invoice_id',
      toTable: 'Invoices',
      toColumn: 'invoice_id',
      inferred: false,
      orphanCount: 0,
      missingRate: 0,
      anomalyPenalty: 0,
    },
    {
      id: 'e_clean_2',
      fromTable: 'Invoices',
      fromColumn: 'customer_id',
      toTable: 'Customers',
      toColumn: 'customer_id',
      inferred: false,
      orphanCount: 0,
      missingRate: 0,
      anomalyPenalty: 0,
    },
  ];

  const paths = enumerateJoinPaths({ tables, edges }, 'Orders', 'Customers');
  assert.equal(paths.length, 2);
  assert.deepEqual(paths[0].tables, ['Orders', 'Invoices', 'Customers']);
  assert.ok(paths[0].resilienceScore > paths[1].resilienceScore);
});

test('parseSqlToQueryGraph extracts tables, columns, edges, and DAG operators', () => {
  const tables: TableSchema[] = [
    {
      name: 'Employees',
      rowCount: 12,
      columns: [
        {
          name: 'emp_id',
          type: 'INTEGER',
          isPrimaryKey: true,
          isForeignKey: false,
          nullable: false,
          missingCount: 0,
          missingRate: 0,
          anomalyCount: 0,
        },
        {
          name: 'dept_id',
          type: 'INTEGER',
          isPrimaryKey: false,
          isForeignKey: true,
          referencesTable: 'Departments',
          referencesColumn: 'dept_id',
          nullable: false,
          missingCount: 0,
          missingRate: 0,
          anomalyCount: 0,
        },
        {
          name: 'salary',
          type: 'REAL',
          isPrimaryKey: false,
          isForeignKey: false,
          nullable: true,
          missingCount: 1,
          missingRate: 0.08,
          anomalyCount: 0,
        },
      ],
    },
    {
      name: 'Departments',
      rowCount: 4,
      columns: [
        {
          name: 'dept_id',
          type: 'INTEGER',
          isPrimaryKey: true,
          isForeignKey: false,
          nullable: false,
          missingCount: 0,
          missingRate: 0,
          anomalyCount: 0,
        },
        {
          name: 'dept_name',
          type: 'TEXT',
          isPrimaryKey: false,
          isForeignKey: false,
          nullable: false,
          missingCount: 0,
          missingRate: 0,
          anomalyCount: 0,
        },
      ],
    },
  ];

  const edges: ForeignKeyEdge[] = [
    {
      id: 'fk_emp_dept',
      fromTable: 'Employees',
      fromColumn: 'dept_id',
      toTable: 'Departments',
      toColumn: 'dept_id',
      inferred: false,
      orphanCount: 0,
      missingRate: 0,
      anomalyPenalty: 0,
    },
  ];

  const sql =
    'SELECT d.dept_name, AVG(e.salary) AS avg_sal FROM Employees e JOIN Departments d ON e.dept_id = d.dept_id WHERE e.salary > 50000 GROUP BY d.dept_name ORDER BY avg_sal DESC LIMIT 5';

  const plan = parseSqlToQueryGraph(sql, tables, edges);
  assert.deepEqual(plan.usedTables, ['Employees', 'Departments']);
  assert.ok(plan.usedEdgeIds.includes('fk_emp_dept'));
  assert.ok(plan.usedColumns.some((c) => c.table === 'Employees' && c.column === 'salary'));
  assert.ok(plan.nodes.some((n) => n.operator === 'JOIN'));
  assert.ok(plan.nodes.some((n) => n.operator === 'FILTER'));
  assert.ok(plan.nodes.some((n) => n.operator === 'GROUP'));
  assert.ok(plan.nodes.some((n) => n.operator === 'SORT'));
  assert.ok(plan.nodes.some((n) => n.operator === 'LIMIT'));
  assert.ok(plan.nodes.some((n) => n.operator === 'PROJECT'));

  // Regression check: joining Orders -> Invoices -> Customers must NOT mark Orders.legacy_customer_id -> Customers.customer_id as used
  const multiTables: TableSchema[] = [
    ...tables,
    {
      name: 'Orders',
      rowCount: 8,
      columns: [
        { name: 'order_id', type: 'INTEGER', isPrimaryKey: true, isForeignKey: false, nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
        { name: 'invoice_id', type: 'INTEGER', isPrimaryKey: false, isForeignKey: true, referencesTable: 'Invoices', referencesColumn: 'invoice_id', nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
        { name: 'legacy_customer_id', type: 'INTEGER', isPrimaryKey: false, isForeignKey: true, referencesTable: 'Customers', referencesColumn: 'customer_id', nullable: true, missingCount: 2, missingRate: 0.25, anomalyCount: 2 },
      ],
    },
    {
      name: 'Invoices',
      rowCount: 8,
      columns: [
        { name: 'invoice_id', type: 'INTEGER', isPrimaryKey: true, isForeignKey: false, nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
        { name: 'customer_id', type: 'INTEGER', isPrimaryKey: false, isForeignKey: true, referencesTable: 'Customers', referencesColumn: 'customer_id', nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
      ],
    },
    {
      name: 'Customers',
      rowCount: 6,
      columns: [
        { name: 'customer_id', type: 'INTEGER', isPrimaryKey: true, isForeignKey: false, nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
        { name: 'customer_name', type: 'TEXT', isPrimaryKey: false, isForeignKey: false, nullable: false, missingCount: 0, missingRate: 0, anomalyCount: 0 },
      ],
    },
  ];
  const multiEdges: ForeignKeyEdge[] = [
    { id: 'clean_inv_cust', fromTable: 'Invoices', fromColumn: 'customer_id', toTable: 'Customers', toColumn: 'customer_id', inferred: false, orphanCount: 0, missingRate: 0, anomalyPenalty: 0 },
    { id: 'clean_ord_inv', fromTable: 'Orders', fromColumn: 'invoice_id', toTable: 'Invoices', toColumn: 'invoice_id', inferred: false, orphanCount: 0, missingRate: 0, anomalyPenalty: 0 },
    { id: 'dirty_ord_cust', fromTable: 'Orders', fromColumn: 'legacy_customer_id', toTable: 'Customers', toColumn: 'customer_id', inferred: true, orphanCount: 2, missingRate: 0.25, anomalyPenalty: 0.825 },
  ];
  const cleanPlan = parseSqlToQueryGraph(
    'SELECT c.customer_name, COUNT(o.order_id) FROM Customers c JOIN Invoices i ON c.customer_id = i.customer_id JOIN Orders o ON i.invoice_id = o.invoice_id GROUP BY c.customer_id',
    multiTables,
    multiEdges
  );
  assert.ok(cleanPlan.usedEdgeIds.includes('clean_inv_cust'));
  assert.ok(cleanPlan.usedEdgeIds.includes('clean_ord_inv'));
  assert.equal(cleanPlan.usedEdgeIds.includes('dirty_ord_cust'), false);
  const firstJoin = cleanPlan.nodes.find((n) => n.operator === 'JOIN');
  assert.ok(firstJoin && firstJoin.detail.includes('c.customer_id = i.customer_id'));
});

test('dataQuality detects missing values, outliers, casing anomalies, and imputes with provenance', () => {
  assert.equal(isMissingValue(null), true);
  assert.equal(isMissingValue('N/A'), true);
  assert.equal(isMissingValue('  '), true);
  assert.equal(isMissingValue(42), false);

  const cols: ColumnSchema[] = [
    {
      name: 'id',
      type: 'INTEGER',
      isPrimaryKey: true,
      isForeignKey: false,
      nullable: false,
      missingCount: 0,
      missingRate: 0,
      anomalyCount: 0,
    },
    {
      name: 'department',
      type: 'TEXT',
      isPrimaryKey: false,
      isForeignKey: false,
      nullable: false,
      missingCount: 0,
      missingRate: 0,
      anomalyCount: 0,
    },
    {
      name: 'salary',
      type: 'REAL',
      isPrimaryKey: false,
      isForeignKey: false,
      nullable: true,
      missingCount: 1,
      missingRate: 0.16,
      anomalyCount: 1,
    },
  ];

  const rows = [
    { id: 1, department: 'Engineering', salary: 100000 },
    { id: 2, department: 'Engineering', salary: 120000 },
    { id: 3, department: 'Engineering', salary: null },
    { id: 4, department: 'Sales', salary: 80000 },
    { id: 5, department: 'sales ', salary: 82000 },
    { id: 6, department: 'Sales', salary: 9500000 },
  ];

  const outlier = detectNumericOutliers(rows, 'Staff', 'salary');
  assert.ok(outlier !== null);
  assert.equal(outlier.affectedRowCount, 1);

  const casing = detectCasingAndWhitespaceAnomalies(rows, 'Staff', 'department');
  assert.ok(casing !== null);

  const { imputedRows, imputedCells } = imputeMissingValues('Staff', rows, cols, 'id');
  assert.equal(imputedCells.length, 1);
  assert.equal(imputedCells[0].columnName, 'salary');
  assert.equal(imputedCells[0].guessedValue, 110000);
  assert.equal(imputedRows[2].salary, 110000);
  assert.ok(imputedCells[0].explanation.includes('department'));
});

test('spiderComparator evaluates order-insensitive and order-sensitive execution match', () => {
  const gold = {
    columns: ['name', 'cnt'],
    rows: [
      { name: 'Alice', cnt: 3 },
      { name: 'Bob', cnt: 2 },
    ],
  };
  const predSwapped = {
    columns: ['n', 'total'],
    rows: [
      { n: 'Bob', total: 2 },
      { n: 'Alice', total: 3 },
    ],
  };

  assert.equal(compareExecutionResults(gold, predSwapped, false), true);
  assert.equal(compareExecutionResults(gold, predSwapped, true), false);

  const f1 = computeComponentMatchF1(
    'SELECT name, COUNT(*) FROM singer GROUP BY name',
    'SELECT name, COUNT(*) FROM singer GROUP BY name ORDER BY COUNT(*) DESC'
  );
  assert.ok(f1 > 0.7 && f1 < 1.0);
});

test('calculateQueryCost ranks lowest-cost clean path ahead of high-anomaly or failing queries', () => {
  const tables: TableSchema[] = [
    { name: 'Orders', rowCount: 500, columns: [] },
    { name: 'Invoices', rowCount: 500, columns: [] },
    { name: 'Customers', rowCount: 100, columns: [] },
  ];

  const cleanCost = calculateQueryCost({
    tables,
    usedTables: ['Orders', 'Invoices', 'Customers'],
    hopCount: 2,
    anomalyPenalty: 0,
    nullLossRate: 0,
    semanticScore: 0.95,
    executionMs: 1.4,
    hasError: false,
    explainSteps: [
      'SCAN Orders',
      'SEARCH Invoices USING INTEGER PRIMARY KEY (rowid=?)',
      'SEARCH Customers USING INTEGER PRIMARY KEY (rowid=?)',
    ],
  });

  const corruptedCost = calculateQueryCost({
    tables,
    usedTables: ['Orders', 'Customers'],
    hopCount: 1,
    anomalyPenalty: 0.85,
    nullLossRate: 0.2,
    semanticScore: 0.85,
    executionMs: 2.1,
    hasError: false,
    explainSteps: [
      'SCAN Orders',
      'SCAN Customers',
      'USE TEMP B-TREE FOR ORDER BY',
    ],
  });

  const failedCost = calculateQueryCost({
    tables,
    usedTables: ['Orders'],
    hopCount: 0,
    anomalyPenalty: 0,
    nullLossRate: 0,
    semanticScore: 0.9,
    executionMs: 0.5,
    hasError: true,
    explainSteps: [],
  });

  assert.ok(cleanCost.totalCost < corruptedCost.totalCost);
  assert.ok(corruptedCost.totalCost < failedCost.totalCost);
  assert.equal(failedCost.failureCost, 10000);
  assert.ok(corruptedCost.anomalyCost > 50);
});

test('parseGeneralLanguageCleaningRule parses plain-English rules into structured actions', async () => {
  const { parseGeneralLanguageCleaningRule } = await import('./anomalyCleaner.ts');

  const negZero = parseGeneralLanguageCleaningRule('set negative values to 0');
  assert.ok(negZero);
  assert.equal(negZero.actionKind, 'set_negative_to');
  assert.equal(negZero.replacementValue, 0);

  const absNeg = parseGeneralLanguageCleaningRule('convert negative numbers to positive');
  assert.ok(absNeg);
  assert.equal(absNeg.actionKind, 'abs_negative');

  const capHigh = parseGeneralLanguageCleaningRule('cap values above 500 to 500');
  assert.ok(capHigh);
  assert.equal(capHigh.actionKind, 'cap_above');
  assert.equal(capHigh.threshold, 500);

  const replaceText = parseGeneralLanguageCleaningRule("replace 'north' with 'North America'");
  assert.ok(replaceText);
  assert.equal(replaceText.actionKind, 'replace_value');
  assert.equal(replaceText.matchValue, 'north');
  assert.equal(replaceText.replacementValue, 'North America');

  const upper = parseGeneralLanguageCleaningRule('trim spaces and convert to uppercase');
  assert.ok(upper);
  assert.equal(upper.actionKind, 'normalize_upper');

  const fillMissing = parseGeneralLanguageCleaningRule('fill missing with Unknown');
  assert.ok(fillMissing);
  assert.equal(fillMissing.actionKind, 'fill_missing_value');
  assert.equal(fillMissing.replacementValue, 'Unknown');

  const delOrphan = parseGeneralLanguageCleaningRule('delete orphan rows');
  assert.ok(delOrphan);
  assert.equal(delOrphan.actionKind, 'delete_orphan_fk');
});
