from __future__ import annotations

import re
from typing import Any

SQL_KEYWORDS = {
    "WHERE",
    "ON",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "OUTER",
    "CROSS",
    "GROUP",
    "ORDER",
    "HAVING",
    "LIMIT",
    "UNION",
    "AS",
    "SET",
    "VALUES",
}


def score_path(table_trail: list[str], edge_trail: list[dict[str, Any]]) -> dict[str, Any]:
    hop_count = len(edge_trail)
    anomaly_penalty = sum(float(e.get("anomalyPenalty", 0.0)) for e in edge_trail)
    missing_penalty = sum(float(e.get("missingRate", 0.0)) for e in edge_trail)
    inferred_penalty = sum(0.08 for e in edge_trail if e.get("inferred"))

    parsimony = 1.0 / (1.0 + 0.35 * max(0, hop_count - 1))
    raw_score = 0.55 * parsimony + 0.45 * max(
        0.0, 1.0 - anomaly_penalty * 0.6 - missing_penalty * 0.5 - inferred_penalty
    )
    resilience_score = round(max(0.05, min(0.99, raw_score)), 3)

    return {
        "tables": list(table_trail),
        "edgeIds": [e["id"] for e in edge_trail],
        "hopCount": hop_count,
        "anomalyPenalty": round(anomaly_penalty, 3),
        "missingPenalty": round(missing_penalty, 3),
        "resilienceScore": resilience_score,
        "summary": " -> ".join(table_trail),
    }


def enumerate_join_paths(
    tables: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    start_table: str,
    end_table: str | None = None,
    max_hops: int = 4,
) -> list[dict[str, Any]]:
    adjacency: dict[str, list[tuple[str, dict[str, Any]]]] = {t["name"]: [] for t in tables}
    for edge in edges:
        if edge["fromTable"] in adjacency and edge["toTable"] in adjacency:
            adjacency[edge["fromTable"]].append((edge["toTable"], edge))
            adjacency[edge["toTable"]].append((edge["fromTable"], edge))

    paths: list[dict[str, Any]] = []

    def dfs(
        current: str,
        visited: set[str],
        table_trail: list[str],
        edge_trail: list[dict[str, Any]],
    ) -> None:
        if end_table and current == end_table and edge_trail:
            paths.append(score_path(table_trail, edge_trail))
            return
        if not end_table and edge_trail:
            paths.append(score_path(table_trail, edge_trail))
        if len(edge_trail) >= max_hops:
            return
        for next_table, edge in adjacency.get(current, []):
            if next_table in visited:
                continue
            visited.add(next_table)
            dfs(next_table, visited, table_trail + [next_table], edge_trail + [edge])
            visited.remove(next_table)

    if start_table in adjacency:
        dfs(start_table, {start_table}, [start_table], [])

    paths.sort(key=lambda p: p["resilienceScore"], reverse=True)
    return paths


def parse_sql_to_query_graph(
    sql: str,
    tables: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, Any]:
    clean_sql = re.sub(r"--.*$", " ", sql, flags=re.MULTILINE)
    clean_sql = re.sub(r"\s+", " ", clean_sql).strip()
    upper = clean_sql.upper()

    table_map: dict[str, dict[str, Any]] = {t["name"].lower(): t for t in tables}
    alias_to_table: dict[str, str] = {}
    used_tables_list: list[str] = []
    used_tables_set: set[str] = set()

    from_join_re = re.compile(
        r'\b(?:FROM|JOIN)\s+["`\[]?([a-zA-Z_][a-zA-Z0-9_]*)["`\]]?(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?',
        re.IGNORECASE,
    )
    for m in from_join_re.finditer(clean_sql):
        raw_tbl = m.group(1)
        resolved = table_map[raw_tbl.lower()]["name"] if raw_tbl.lower() in table_map else raw_tbl
        if resolved not in used_tables_set:
            used_tables_set.add(resolved)
            used_tables_list.append(resolved)
        alias_to_table[resolved.lower()] = resolved
        alias = m.group(2)
        if alias and alias.upper() not in SQL_KEYWORDS:
            alias_to_table[alias.lower()] = resolved

    used_cols_map: dict[str, dict[str, str]] = {}
    qual_re = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b")
    for m in qual_re.finditer(clean_sql):
        alias_key = m.group(1).lower()
        col = m.group(2)
        if alias_key in alias_to_table:
            t_name = alias_to_table[alias_key]
            schema_t = table_map.get(t_name.lower())
            matched_col = None
            if schema_t:
                for c in schema_t.get("columns", []):
                    if c["name"].lower() == col.lower():
                        matched_col = c["name"]
                        break
            col_name = matched_col or col
            used_cols_map[f"{t_name}.{col_name}"] = {"table": t_name, "column": col_name}

    for t_name in used_tables_list:
        schema_t = table_map.get(t_name.lower())
        if not schema_t:
            continue
        for c in schema_t.get("columns", []):
            if re.search(rf"\b{re.escape(c['name'])}\b", clean_sql, re.IGNORECASE):
                used_cols_map[f"{t_name}.{c['name']}"] = {"table": t_name, "column": c["name"]}

    used_edge_ids: list[str] = []
    for edge in edges:
        if edge["fromTable"] not in used_tables_set or edge["toTable"] not in used_tables_set:
            continue
        fc = re.escape(edge["fromColumn"])
        tc = re.escape(edge["toColumn"])
        fwd = re.compile(rf"\b[a-zA-Z_][a-zA-Z0-9_]*\.{fc}\s*=\s*[a-zA-Z_][a-zA-Z0-9_]*\.{tc}\b", re.IGNORECASE)
        rev = re.compile(rf"\b[a-zA-Z_][a-zA-Z0-9_]*\.{tc}\s*=\s*[a-zA-Z_][a-zA-Z0-9_]*\.{fc}\b", re.IGNORECASE)
        using_re = re.compile(rf"\bUSING\s*\(\s*{fc}\s*\)", re.IGNORECASE)
        has_from = f"{edge['fromTable']}.{edge['fromColumn']}" in used_cols_map
        has_to = f"{edge['toTable']}.{edge['toColumn']}" in used_cols_map
        if fwd.search(clean_sql) or rev.search(clean_sql) or using_re.search(clean_sql) or (has_from and has_to):
            used_edge_ids.append(edge["id"])

    nodes: list[dict[str, Any]] = []
    graph_edges: list[dict[str, str]] = []
    scan_ids: list[str] = []

    for idx, t_name in enumerate(used_tables_list):
        scan_id = f"scan_{idx}"
        t_cols = [c["column"] for c in used_cols_map.values() if c["table"] == t_name]
        schema_t = table_map.get(t_name.lower())
        node: dict[str, Any] = {
            "id": scan_id,
            "operator": "SCAN",
            "label": f"Scan {t_name}",
            "detail": f"{schema_t['rowCount']} rows" if schema_t else "Virtual relation",
            "columns": t_cols,
        }
        if schema_t:
            node["estimatedRows"] = schema_t["rowCount"]
        nodes.append(node)
        scan_ids.append(scan_id)

    if not scan_ids:
        nodes.append(
            {
                "id": "scan_0",
                "operator": "SCAN",
                "label": "Inferred Relation",
                "detail": "Text-only virtual table",
                "columns": [],
            }
        )
        scan_ids.append("scan_0")

    current_tip = scan_ids[0]

    if len(scan_ids) > 1:
        on_re = re.compile(
            r"\bON\s+(.+?)(?=\s+(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\b|\s+WHERE\b|\s+GROUP\s+BY\b|\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|;|$)",
            re.IGNORECASE,
        )
        on_clauses = [m.group(1).strip() for m in on_re.finditer(clean_sql)]
        is_left = bool(re.search(r"\bLEFT\s+(?:OUTER\s+)?JOIN\b", clean_sql, re.IGNORECASE))
        for i in range(1, len(scan_ids)):
            join_id = f"join_{i}"
            detail = on_clauses[i - 1][:48] if i - 1 < len(on_clauses) else "Relational key match"
            nodes.append(
                {
                    "id": join_id,
                    "operator": "JOIN",
                    "label": "Left Join" if is_left else "Inner Join",
                    "detail": detail,
                    "columns": [],
                }
            )
            graph_edges.append({"from": current_tip, "to": join_id, "label": "left"})
            graph_edges.append({"from": scan_ids[i], "to": join_id, "label": "right"})
            current_tip = join_id

    where_m = re.search(
        r"\bWHERE\s+(.+?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)",
        clean_sql,
        re.IGNORECASE,
    )
    if where_m:
        nodes.append(
            {
                "id": "filter_0",
                "operator": "FILTER",
                "label": "Filter (WHERE)",
                "detail": where_m.group(1).strip()[:56],
                "columns": [],
            }
        )
        graph_edges.append({"from": current_tip, "to": "filter_0"})
        current_tip = "filter_0"

    group_m = re.search(
        r"\bGROUP\s+BY\s+(.+?)(?=\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)",
        clean_sql,
        re.IGNORECASE,
    )
    has_agg = bool(re.search(r"\b(COUNT|SUM|AVG|MIN|MAX)\s*\(", clean_sql, re.IGNORECASE))
    if group_m or has_agg:
        nodes.append(
            {
                "id": "agg_0",
                "operator": "GROUP" if group_m else "AGGREGATE",
                "label": "Group & Aggregate" if group_m else "Aggregate",
                "detail": f"BY {group_m.group(1).strip()[:46]}" if group_m else "Scalar aggregation",
                "columns": [],
            }
        )
        graph_edges.append({"from": current_tip, "to": "agg_0"})
        current_tip = "agg_0"

    order_m = re.search(r"\bORDER\s+BY\s+(.+?)(?=\bLIMIT\b|;|$)", clean_sql, re.IGNORECASE)
    if order_m:
        nodes.append(
            {
                "id": "sort_0",
                "operator": "SORT",
                "label": "Sort (ORDER BY)",
                "detail": order_m.group(1).strip()[:50],
                "columns": [],
            }
        )
        graph_edges.append({"from": current_tip, "to": "sort_0"})
        current_tip = "sort_0"

    limit_m = re.search(r"\bLIMIT\s+(\d+)", clean_sql, re.IGNORECASE)
    if limit_m:
        nodes.append(
            {
                "id": "limit_0",
                "operator": "LIMIT",
                "label": f"Limit ({limit_m.group(1)})",
                "detail": f"Top {limit_m.group(1)} rows",
                "columns": [],
            }
        )
        graph_edges.append({"from": current_tip, "to": "limit_0"})
        current_tip = "limit_0"

    select_m = re.search(
        r"\bSELECT\s+(?:DISTINCT\s+)?(.+?)(?=\bFROM\b|;|$)", clean_sql, re.IGNORECASE
    )
    proj_cols = (
        [s.strip() for s in select_m.group(1).split(",") if s.strip()][:6]
        if select_m
        else ["*"]
    )
    nodes.append(
        {
            "id": "project_0",
            "operator": "PROJECT",
            "label": "Distinct Project" if "SELECT DISTINCT" in upper else "Project Output",
            "detail": ", ".join(proj_cols)[:56],
            "columns": proj_cols,
        }
    )
    graph_edges.append({"from": current_tip, "to": "project_0"})

    return {
        "nodes": nodes,
        "edges": graph_edges,
        "usedTables": used_tables_list,
        "usedColumns": list(used_cols_map.values()),
        "usedEdgeIds": used_edge_ids,
    }


def inspect_sqlite_explain_plan(conn: Any, sql: str) -> list[str]:
    clean = sql.strip().rstrip(";")
    if not clean:
        return []
    upper = clean.lstrip().upper()
    if not (upper.startswith("SELECT") or upper.startswith("WITH")):
        return []
    try:
        rows = conn.execute(f"EXPLAIN QUERY PLAN {clean}").fetchall()
        steps: list[str] = []
        for row in rows:
            if isinstance(row, dict):
                detail = str(row.get("detail") or "")
            else:
                detail = str(row[-1]) if row else ""
            if detail:
                steps.append(detail)
        return steps
    except Exception:
        return []


def calculate_query_cost(
    tables: list[dict[str, Any]],
    used_tables: list[str],
    hop_count: int,
    anomaly_penalty: float,
    null_loss_rate: float,
    semantic_score: float,
    execution_ms: float,
    has_error: bool,
    explain_steps: list[str] | None = None,
) -> dict[str, Any]:
    import math

    steps = list(explain_steps or [])
    row_lookup = {str(t.get("name", "")).lower(): int(t.get("rowCount", 0) or 0) for t in tables}

    failure_cost = 10000.0 if has_error else 0.0
    plan_cost = 0.0

    if steps:
        for step in steps:
            up = step.upper()
            if "SCAN " in up:
                tbl_match = re.search(r"\bSCAN\s+([a-zA-Z0-9_]+)", step, re.IGNORECASE)
                tbl_rows = row_lookup.get(tbl_match.group(1).lower(), 10) if tbl_match else 10
                plan_cost += max(4.0, math.log1p(max(1, tbl_rows)) * 4.5)
            elif "SEARCH " in up:
                plan_cost += 1.5
            if "TEMP B-TREE" in up:
                plan_cost += 10.0
            if "SUBQUERY" in up or "CORRELATED" in up or "CO-ROUTINE" in up or "COMPOUND" in up:
                plan_cost += 8.0
    else:
        for t_name in used_tables:
            tbl_rows = row_lookup.get(t_name.lower(), 10)
            plan_cost += max(3.5, math.log1p(max(1, tbl_rows)) * 3.5)
        if not used_tables:
            plan_cost = 4.0

    join_cost = float(hop_count * 9.0 + max(0, len(used_tables) - 1) * 3.0)
    anomaly_cost = float(anomaly_penalty * 65.0 + null_loss_rate * 35.0)
    semantic_cost = float(max(0.0, 1.0 - max(0.0, min(1.0, semantic_score))) * 40.0)
    latency_cost = float(min(50.0, max(0.0, execution_ms) * 0.5))

    plan_cost_r = round(plan_cost, 2)
    join_cost_r = round(join_cost, 2)
    anomaly_cost_r = round(anomaly_cost, 2)
    semantic_cost_r = round(semantic_cost, 2)
    latency_cost_r = round(latency_cost, 2)
    failure_cost_r = round(failure_cost, 2)
    total_cost = round(
        failure_cost_r + plan_cost_r + join_cost_r + anomaly_cost_r + semantic_cost_r + latency_cost_r,
        2,
    )

    return {
        "planCost": plan_cost_r,
        "joinCost": join_cost_r,
        "anomalyCost": anomaly_cost_r,
        "semanticCost": semantic_cost_r,
        "latencyCost": latency_cost_r,
        "failureCost": failure_cost_r,
        "totalCost": total_cost,
        "planSteps": steps,
    }
