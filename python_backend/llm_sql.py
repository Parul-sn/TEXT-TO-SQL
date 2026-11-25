from __future__ import annotations

import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .db_manager import execute_read_only_sql, profile_connection, profile_sqlite_file
from .env_loader import LlmConfig, get_llm_configs
from .graph_engine import (
    calculate_query_cost,
    enumerate_join_paths,
    inspect_sqlite_explain_plan,
    parse_sql_to_query_graph,
)

_COOLDOWN_LOCK = threading.Lock()
_KEY_COOLDOWNS: dict[str, float] = {}


def _slot_identity(cfg: LlmConfig) -> str:
    return f"{cfg.slot}:{cfg.api_key}"


def _cooldown_seconds_for_error(code: int, message: str) -> float:
    low = message.lower()
    if code == 429 or any(tok in low for tok in ("rate_limit", "rate limit", "token", "tpm", "tpd", "rpm")):
        return 60.0
    if code in (401, 402, 403) or any(tok in low for tok in ("quota", "insufficient", "invalid_api_key", "billing")):
        return 120.0
    return 20.0


def _order_slots_by_health(configs: list[LlmConfig]) -> list[LlmConfig]:
    now = time.time()
    ready: list[LlmConfig] = []
    cooled: list[tuple[float, LlmConfig]] = []
    with _COOLDOWN_LOCK:
        for cfg in configs:
            until = _KEY_COOLDOWNS.get(_slot_identity(cfg), 0.0)
            if until <= now:
                ready.append(cfg)
            else:
                cooled.append((until, cfg))
    cooled.sort(key=lambda item: item[0])
    return ready + [cfg for _, cfg in cooled]


def _mark_slot_cooldown(cfg: LlmConfig, seconds: float) -> None:
    with _COOLDOWN_LOCK:
        _KEY_COOLDOWNS[_slot_identity(cfg)] = time.time() + seconds


def _clear_slot_cooldown(cfg: LlmConfig) -> None:
    with _COOLDOWN_LOCK:
        _KEY_COOLDOWNS.pop(_slot_identity(cfg), None)


def _clean_sql_output(sql: str) -> str:
    s = sql.strip()
    if s.lower().startswith("```sql"):
        s = s[6:].strip()
    elif s.startswith("```"):
        s = s[3:].strip()
    if s.endswith("```"):
        s = s[:-3].strip()
    return s.strip()


def _safe_json_parse(raw: str | None) -> dict[str, Any]:
    txt = (raw or "{}").strip()
    if txt.startswith("```json"):
        txt = txt[7:].strip()
    elif txt.startswith("```"):
        txt = txt[3:].strip()
    if txt.endswith("```"):
        txt = txt[:-3].strip()

    try:
        parsed = json.loads(txt)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = txt.find("{")
    end = txt.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(txt[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("Failed to parse structured JSON response from the configured LLM.")


def _resolve_chat_completions_url(base_url: str) -> str:
    clean = base_url.rstrip("/")
    if clean.endswith("/chat/completions"):
        return clean
    return f"{clean}/chat/completions"


def _call_llm_structured_with_meta(
    system_instruction: str,
    user_prompt: str,
    schema_hint: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    configs = get_llm_configs()
    ordered_slots = _order_slots_by_health(configs)

    system_msg = (
        f"{system_instruction}\n\n"
        f"IMPORTANT: Respond ONLY with valid JSON matching this schema:\n{schema_hint}"
    )

    failovers: list[str] = []
    errors_by_slot: list[str] = []
    single_key_mode = len(ordered_slots) == 1

    for slot_idx, cfg in enumerate(ordered_slots):
        endpoint = _resolve_chat_completions_url(cfg.base_url)
        payload: dict[str, Any] = {
            "model": cfg.model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }
        body = json.dumps(payload).encode("utf-8")

        max_attempts_this_slot = 2 if single_key_mode else 1
        attempt = 0
        while attempt < max_attempts_this_slot:
            attempt += 1
            req = urllib.request.Request(
                endpoint,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "GraphSQL-Studio/1.0",
                    "Authorization": f"Bearer {cfg.api_key}",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=cfg.timeout_sec) as resp:
                    raw_resp = resp.read().decode("utf-8")
                outer = json.loads(raw_resp)
                choices = outer.get("choices") or []
                if not choices:
                    raise RuntimeError("Configured LLM endpoint returned no choices.")
                msg = choices[0].get("message") or {}
                content = msg.get("content") or ""
                parsed = _safe_json_parse(str(content))
                _clear_slot_cooldown(cfg)
                meta = {
                    "keySlot": cfg.slot,
                    "maskedKey": cfg.masked_key,
                    "model": cfg.model,
                    "totalKeysConfigured": len(configs),
                    "failovers": failovers,
                }
                return parsed, meta
            except urllib.error.HTTPError as exc:
                err_body = exc.read().decode("utf-8", errors="replace")
                if exc.code == 400 and "response_format" in payload and "response_format" in err_body:
                    payload.pop("response_format", None)
                    body = json.dumps(payload).encode("utf-8")
                    attempt -= 1
                    max_attempts_this_slot = max(max_attempts_this_slot, 1)
                    continue

                reason = f"HTTP {exc.code}: {err_body[:240]}"
                if single_key_mode and exc.code in (429, 502, 503, 504) and attempt < max_attempts_this_slot:
                    time.sleep(1.5)
                    continue

                _mark_slot_cooldown(cfg, _cooldown_seconds_for_error(exc.code, err_body))
                errors_by_slot.append(f"Key #{cfg.slot} ({cfg.masked_key}) [{reason}]")
                if slot_idx < len(ordered_slots) - 1:
                    next_cfg = ordered_slots[slot_idx + 1]
                    failovers.append(
                        f"Key #{cfg.slot} ({cfg.masked_key}) hit HTTP {exc.code} -> switched to Key #{next_cfg.slot} ({next_cfg.masked_key})"
                    )
                break
            except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
                reason = str(getattr(exc, "reason", exc))[:240]
                if single_key_mode and attempt < max_attempts_this_slot:
                    time.sleep(1.0)
                    continue

                _mark_slot_cooldown(cfg, 20.0)
                errors_by_slot.append(f"Key #{cfg.slot} ({cfg.masked_key}) [{reason}]")
                if slot_idx < len(ordered_slots) - 1:
                    next_cfg = ordered_slots[slot_idx + 1]
                    failovers.append(
                        f"Key #{cfg.slot} ({cfg.masked_key}) error ({reason[:80]}) -> switched to Key #{next_cfg.slot} ({next_cfg.masked_key})"
                    )
                break

    raise RuntimeError(
        f"All configured API keys failed ({len(ordered_slots)} tried): " + " | ".join(errors_by_slot)
    )


def _call_llm_structured(
    system_instruction: str,
    user_prompt: str,
    schema_hint: str,
) -> dict[str, Any]:
    parsed, _ = _call_llm_structured_with_meta(system_instruction, user_prompt, schema_hint)
    return parsed


def format_schema_context(profile: dict[str, Any]) -> str:
    table_lines: list[str] = []
    for t in profile.get("tables", []):
        col_lines: list[str] = []
        for c in t.get("columns", []):
            flags: list[str] = []
            if c.get("isPrimaryKey"):
                flags.append("PK")
            if c.get("isForeignKey") and c.get("referencesTable"):
                flags.append(f"FK->{c['referencesTable']}.{c['referencesColumn']}")
            if c.get("missingCount", 0) > 0:
                flags.append(f"missing:{c['missingCount']}/{t['rowCount']}")
            if c.get("anomalyCount", 0) > 0:
                flags.append(f"anomalies:{c['anomalyCount']}")
            flag_str = f", {', '.join(flags)}" if flags else ""
            col_lines.append(f"  - {c['name']} ({c['type']}{flag_str})")
        table_lines.append(f"TABLE {t['name']} ({t['rowCount']} rows):\n" + "\n".join(col_lines))

    edges = profile.get("edges", [])
    edge_lines = [
        f"EDGE [{e['id']}]: {e['fromTable']}.{e['fromColumn']} -> {e['toTable']}.{e['toColumn']} "
        f"| inferred={e['inferred']} | orphanCount={e['orphanCount']} | missingRate={e['missingRate']} | anomalyPenalty={e['anomalyPenalty']}"
        for e in edges
    ]

    multi_path_notes: list[str] = []
    tables = profile.get("tables", [])
    for i in range(len(tables)):
        for j in range(i + 1, len(tables)):
            a = tables[i]["name"]
            b = tables[j]["name"]
            paths = enumerate_join_paths(tables, edges, a, b, 4)
            if len(paths) > 1:
                formatted = " | ".join(
                    f"Path {idx + 1}: {p['summary']} (hops={p['hopCount']}, resilience={p['resilienceScore']}, anomalyPenalty={p['anomalyPenalty']})"
                    for idx, p in enumerate(paths[:3])
                )
                multi_path_notes.append(f"Routes {a} <-> {b}: {formatted}")

    anomalies = profile.get("anomalies", [])
    anomaly_notes = (
        "\n".join(
            f"- [{str(a['severity']).upper()}] {a['tableName']}.{a['columnName']}: {a['description']}"
            for a in anomalies
        )
        if anomalies
        else "None detected."
    )

    return "\n".join(
        [
            "=== DATABASE SCHEMA ===",
            "\n\n".join(table_lines),
            "",
            "=== FOREIGN KEY GRAPH EDGES ===",
            "\n".join(edge_lines) if edge_lines else "No explicit foreign key edges.",
            "",
            "=== MULTI-PATH GRAPH ROUTES ===",
            "\n".join(multi_path_notes) if multi_path_notes else "Single unique path per table pair.",
            "",
            "=== DATA ANOMALIES & MISSINGNESS ===",
            anomaly_notes,
        ]
    )


def repair_sql_with_llm(
    question: str,
    schema_context: str,
    failed_sql: str,
    sqlite_error: str,
    retry_number: int,
) -> dict[str, Any]:
    prompt = f"""{schema_context}

ORIGINAL USER QUESTION: "{question}"
FAILING SQL (Retry {retry_number}/5):
{failed_sql}

SQLITE EXECUTION ERROR:
{sqlite_error}

Fix the SQLite query so it executes without error and accurately answers the question using only existing tables and columns."""

    schema_hint = '{ "diagnosis": "string", "fixedSql": "string" }'
    parsed, meta = _call_llm_structured_with_meta(
        system_instruction=(
            "You are a SQLite SQL Self-Healing Repair module. "
            "Diagnose the exact SQLite error and return a valid, corrected SQLite SELECT query."
        ),
        user_prompt=prompt,
        schema_hint=schema_hint,
    )
    return {
        "diagnosis": str(parsed.get("diagnosis") or f"Repair attempt {retry_number} applied."),
        "fixedSql": str(parsed.get("fixedSql") or failed_sql),
        "llmMeta": meta,
    }


def _run_text_only_generation(question: str) -> dict[str, Any]:
    schema_hint = (
        '{ "inferredDdl": "CREATE TABLE ...", "explanation": "string", '
        '"candidates": [{ "label": "string", "strategy": "string", "sql": "SELECT ...", '
        '"graphPathTables": ["TableA"], "semanticScore": 0.9, "rationale": "string" }] }'
    )
    parsed, llm_meta = _call_llm_structured_with_meta(
        system_instruction=(
            "You are GraphSQL running in Text-Only Schema-Free Mode. "
            "Infer normalized tables/foreign keys, produce clean ANSI/SQLite SQL queries, and explain the relational paths."
        ),
        user_prompt=(
            f'User question (no database file provided): "{question}"\n'
            "Infer a clean, realistic relational SQLite schema (CREATE TABLE DDL) that supports this question, "
            "and generate 2 candidate SQL queries (e.g. Standard Aggregation vs CTE/Windowed Path) with an explanation."
        ),
        schema_hint=schema_hint,
    )
    all_failovers = list(llm_meta.get("failovers") or [])

    inferred_ddl = str(parsed.get("inferredDdl") or "")
    explanation = str(parsed.get("explanation") or "")
    raw_cands = parsed.get("candidates") or []

    temp_conn = sqlite3.connect(":memory:")
    syntax_valid = True
    syntax_error: str | None = None
    profile: dict[str, Any] = {
        "tables": [],
        "edges": [],
        "totalRows": 0,
        "totalMissingCells": 0,
        "totalAnomalies": 0,
        "imputedCells": [],
        "anomalies": [],
    }
    try:
        if inferred_ddl:
            temp_conn.executescript(inferred_ddl)
            profile = profile_connection(temp_conn)
    except Exception as exc:
        syntax_valid = False
        syntax_error = str(exc)

    def _exec_mem(sql_txt: str) -> dict[str, Any]:
        start_t = time.perf_counter()
        try:
            cur = temp_conn.execute(sql_txt)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [{cols[i]: r[i] for i in range(len(cols))} for r in cur.fetchall()]
            return {
                "columns": cols,
                "rows": rows,
                "rowCount": len(rows),
                "executionMs": round((time.perf_counter() - start_t) * 1000.0, 2),
            }
        except Exception as exc:
            return {
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "executionMs": round((time.perf_counter() - start_t) * 1000.0, 2),
                "error": str(exc),
            }

    candidates: list[dict[str, Any]] = []
    repair_attempts: list[dict[str, Any]] = []

    try:
        for i, c in enumerate(raw_cands[:3]):
            sql = _clean_sql_output(str(c.get("sql") or ""))
            exec_res: dict[str, Any] = {"columns": [], "rows": [], "rowCount": 0, "executionMs": 0.0}
            if syntax_valid and profile["tables"]:
                exec_res = _exec_mem(sql)

            if i == 0:
                repair_attempts.append(
                    {
                        "attemptNumber": 1,
                        "isInitial": True,
                        "sql": sql,
                        "status": "error" if exec_res.get("error") else "success",
                        "errorMessage": exec_res.get("error"),
                        "diagnosis": (
                            f"Validated against inferred DDL failed: {exec_res['error']}"
                            if exec_res.get("error")
                            else "Validated cleanly against inferred SQLite schema."
                        ),
                        "executionMs": exec_res.get("executionMs", 0.0),
                    }
                )
                retries = 0
                while exec_res.get("error") and retries < 5 and syntax_valid:
                    retries += 1
                    repaired = repair_sql_with_llm(
                        question,
                        inferred_ddl,
                        sql,
                        str(exec_res["error"]),
                        retries,
                    )
                    rep_meta = repaired.get("llmMeta") or {}
                    all_failovers.extend(rep_meta.get("failovers") or [])
                    llm_meta = {**rep_meta, "failovers": all_failovers}
                    sql = _clean_sql_output(repaired["fixedSql"])
                    exec_res = _exec_mem(sql)
                    repair_attempts.append(
                        {
                            "attemptNumber": 1 + retries,
                            "isInitial": False,
                            "sql": sql,
                            "status": "error" if exec_res.get("error") else "success",
                            "errorMessage": exec_res.get("error"),
                            "diagnosis": repaired["diagnosis"],
                            "executionMs": exec_res.get("executionMs", 0.0),
                        }
                    )

            plan = parse_sql_to_query_graph(sql, profile["tables"], profile["edges"])
            explain_steps = (
                inspect_sqlite_explain_plan(temp_conn, sql)
                if syntax_valid and not exec_res.get("error")
                else []
            )
            sem = round(max(0.1, min(1.0, float(c.get("semanticScore") or 0.85))), 3)
            cost_breakdown = calculate_query_cost(
                tables=profile["tables"],
                used_tables=plan["usedTables"],
                hop_count=len(plan["usedEdgeIds"]),
                anomaly_penalty=0.0,
                null_loss_rate=0.0,
                semantic_score=sem,
                execution_ms=float(exec_res.get("executionMs") or 0.0),
                has_error=bool(exec_res.get("error")),
                explain_steps=explain_steps,
            )
            rationale = str(c.get("rationale") or "")
            candidates.append(
                {
                    "id": f"txt_cand_{i + 1}",
                    "label": str(c.get("label") or f"Candidate {i + 1}"),
                    "strategy": str(c.get("strategy") or "Schema-Free Synthesis"),
                    "sql": sql,
                    "graphPathTables": plan["usedTables"] or list(c.get("graphPathTables") or []),
                    "graphPathEdges": plan["usedEdgeIds"],
                    "usedColumns": plan["usedColumns"],
                    "hopCount": len(plan["usedEdgeIds"]),
                    "semanticScore": sem,
                    "anomalyPenalty": 0.0,
                    "nullLossRate": 0.0,
                    "resilienceScore": sem,
                    "queryCost": cost_breakdown["totalCost"],
                    "costBreakdown": cost_breakdown,
                    "selected": False,
                    "selectionReason": rationale,
                    "execution": exec_res,
                }
            )
    finally:
        temp_conn.close()

    if candidates:
        candidates.sort(key=lambda item: (item["queryCost"], -item["resilienceScore"]))
        winner = candidates[0]
        winner["selected"] = True
        winner["selectionReason"] = (
            f"Selected Lowest-Cost Query (Cost {winner['queryCost']}): {winner['selectionReason']}"
        )
        for alt in candidates[1:]:
            alt["selected"] = False
            if alt["execution"].get("error"):
                alt["selectionReason"] = f"Not Selected — Execution failed ({alt['execution']['error']})."
            else:
                delta = round(alt["queryCost"] - winner["queryCost"], 2)
                alt["selectionReason"] = (
                    f"Not Selected — Higher query cost ({alt['queryCost']} vs {winner['queryCost']}, +{delta})."
                )
    else:
        winner = None

    query_graph = parse_sql_to_query_graph(
        winner["sql"] if winner else "",
        profile["tables"],
        profile["edges"],
    )
    llm_meta["failovers"] = all_failovers
    return {
        "mode": "text_only",
        "question": question,
        "inferredDdl": inferred_ddl,
        "selectedSql": winner["sql"] if winner else "",
        "explanation": explanation,
        "candidates": candidates,
        "repairAttempts": repair_attempts,
        "totalAttempts": len(repair_attempts),
        "healedOnRetry": (
            len(repair_attempts) > 1 and repair_attempts[-1].get("status") == "success"
        ),
        "queryGraph": query_graph,
        "result": winner["execution"] if winner else {"columns": [], "rows": [], "rowCount": 0, "executionMs": 0},
        "dataWarnings": (
            [f"Inferred schema note: {syntax_error}"]
            if syntax_error
            else [
                "Text-Only Mode: SQL generated from natural language and syntax-verified against inferred DDL (no .db/.sql data rows loaded)."
            ]
        ),
        "llmMeta": llm_meta,
    }


def generate_and_run_text_to_sql(
    question: str,
    db_path: str | Path | None,
    force_text_only: bool = False,
    max_candidates: int = 3,
    apply_imputation_overlay: bool = True,
) -> dict[str, Any]:
    if not db_path or force_text_only:
        return _run_text_only_generation(question)

    profile = profile_sqlite_file(db_path)
    schema_context = format_schema_context(profile)

    multi_rule = (
        "1 optimal SQLite SELECT query"
        if max_candidates == 1
        else "2 to 3 distinct SQLite SELECT candidate queries representing different graph join paths or anomaly-defensive strategies (for example: Primary Clean Path vs Direct Legacy/Shortcut Path vs Defensive LEFT JOIN + TRIM/LOWER/COALESCE query when casing/missingness anomalies exist)"
    )

    system_instruction = f"""You are GraphSQL, an Anomaly-Aware Multi-Path Text-to-SQL engine targeting SQLite.
Given a user question, a relational schema graph with edge anomaly penalties, and missing-value statistics:
1. Generate {multi_rule}.
2. Always use exact table and column names from the schema. Never invent columns.
3. For each candidate, specify the ordered table path (graphPathTables), a short strategy label, semantic alignment score (0.0-1.0), and clear reasoning.
4. Put your strongest recommended SQL query first."""

    prompt = f'{schema_context}\n\nUSER QUESTION: "{question}"\n\nGenerate candidate SQLite SELECT queries with multi-path graph traces.'
    schema_hint = (
        '{ "explanation": "string", '
        '"candidates": [{ "label": "string", "strategy": "string", "sql": "SELECT ...", '
        '"graphPathTables": ["TableA"], "semanticScore": 0.9, "rationale": "string" }] }'
    )

    parsed, llm_meta = _call_llm_structured_with_meta(
        system_instruction=system_instruction,
        user_prompt=prompt,
        schema_hint=schema_hint,
    )
    all_failovers = list(llm_meta.get("failovers") or [])

    raw_cands = parsed.get("candidates") or []
    if not raw_cands:
        first_tbl = profile["tables"][0]["name"] if profile["tables"] else "sqlite_master"
        raw_cands = [
            {
                "label": "Primary Query",
                "strategy": "Direct Schema Projection",
                "sql": f'SELECT * FROM "{first_tbl}" LIMIT 10;',
                "graphPathTables": [first_tbl] if profile["tables"] else [],
                "semanticScore": 0.7,
                "rationale": "Fallback query generated when candidate array was empty.",
            }
        ]
    raw_cands = raw_cands[:max_candidates]

    repair_attempts: list[dict[str, Any]] = []
    evaluated: list[dict[str, Any]] = []

    explain_conn = sqlite3.connect(str(db_path))
    try:
        for idx, raw in enumerate(raw_cands):
            current_sql = _clean_sql_output(str(raw.get("sql") or ""))
            exec_res = execute_read_only_sql(
                db_path, current_sql, apply_imputation_overlay=apply_imputation_overlay
            )

            if idx == 0:
                repair_attempts.append(
                    {
                        "attemptNumber": 1,
                        "isInitial": True,
                        "sql": current_sql,
                        "status": "error" if exec_res.get("error") else "success",
                        "errorMessage": exec_res.get("error"),
                        "diagnosis": (
                            f"Initial execution failed: {exec_res['error']}"
                            if exec_res.get("error")
                            else "Initial candidate executed cleanly on SQLite."
                        ),
                        "executionMs": exec_res.get("executionMs", 0.0),
                    }
                )

                retry_count = 0
                while exec_res.get("error") and retry_count < 5:
                    retry_count += 1
                    repaired = repair_sql_with_llm(
                        question,
                        schema_context,
                        current_sql,
                        str(exec_res["error"]),
                        retry_count,
                    )
                    rep_meta = repaired.get("llmMeta") or {}
                    all_failovers.extend(rep_meta.get("failovers") or [])
                    llm_meta = {**rep_meta, "failovers": all_failovers}
                    current_sql = _clean_sql_output(repaired["fixedSql"])
                    exec_res = execute_read_only_sql(
                        db_path, current_sql, apply_imputation_overlay=apply_imputation_overlay
                    )
                    repair_attempts.append(
                        {
                            "attemptNumber": 1 + retry_count,
                            "isInitial": False,
                            "sql": current_sql,
                            "status": "error" if exec_res.get("error") else "success",
                            "errorMessage": exec_res.get("error"),
                            "diagnosis": repaired["diagnosis"],
                            "executionMs": exec_res.get("executionMs", 0.0),
                        }
                    )

            plan = parse_sql_to_query_graph(current_sql, profile["tables"], profile["edges"])
            hop_count = len(plan["usedEdgeIds"])
            used_edge_set = set(plan["usedEdgeIds"])
            used_edges = [e for e in profile["edges"] if e["id"] in used_edge_set]
            anomaly_penalty = round(sum(float(e.get("anomalyPenalty", 0.0)) for e in used_edges), 3)

            rows_len = len(exec_res.get("rows") or [])
            cols_len = max(1, len(exec_res.get("columns") or []))
            total_cells = max(1, rows_len * cols_len)
            markers = exec_res.get("imputedCellMarkers") or {}
            imputed_in_res = sum(len(v) for v in markers.values() if isinstance(v, dict))
            null_loss_rate = round(imputed_in_res / total_cells, 3)

            sem_score = max(0.1, min(1.0, float(raw.get("semanticScore") or 0.8)))
            exec_bonus = -0.85 if exec_res.get("error") else 0.25
            row_bonus = 0.1 if (not exec_res.get("error") and exec_res.get("rowCount", 0) > 0) else 0.0
            raw_resilience = (
                0.48 * sem_score
                + 0.22 * (1.0 / (1.0 + 0.25 * max(0, hop_count - 1)))
                + exec_bonus
                + row_bonus
                - 0.38 * anomaly_penalty
                - 0.2 * null_loss_rate
            )
            resilience_score = round(max(0.01, min(0.99, raw_resilience)), 3)

            explain_steps = (
                inspect_sqlite_explain_plan(explain_conn, current_sql)
                if not exec_res.get("error")
                else []
            )
            cost_breakdown = calculate_query_cost(
                tables=profile["tables"],
                used_tables=plan["usedTables"],
                hop_count=hop_count,
                anomaly_penalty=anomaly_penalty,
                null_loss_rate=null_loss_rate,
                semantic_score=sem_score,
                execution_ms=float(exec_res.get("executionMs") or 0.0),
                has_error=bool(exec_res.get("error")),
                explain_steps=explain_steps,
            )

            evaluated.append(
                {
                    "id": f"cand_{idx + 1}",
                    "label": str(raw.get("label") or f"Candidate {idx + 1}"),
                    "strategy": str(raw.get("strategy") or "Graph Path"),
                    "sql": current_sql,
                    "graphPathTables": plan["usedTables"] or list(raw.get("graphPathTables") or []),
                    "graphPathEdges": plan["usedEdgeIds"],
                    "usedColumns": plan["usedColumns"],
                    "hopCount": hop_count,
                    "semanticScore": round(sem_score, 3),
                    "anomalyPenalty": anomaly_penalty,
                    "nullLossRate": null_loss_rate,
                    "resilienceScore": resilience_score,
                    "queryCost": cost_breakdown["totalCost"],
                    "costBreakdown": cost_breakdown,
                    "selected": False,
                    "selectionReason": str(raw.get("rationale") or ""),
                    "execution": exec_res,
                }
            )
    finally:
        explain_conn.close()

    # Select lowest-cost runnable query (cost comparison: lower queryCost is better)
    evaluated.sort(
        key=lambda c: (1 if c["execution"].get("error") else 0, c["queryCost"], -c["resilienceScore"])
    )

    winner = evaluated[0]
    winner["selected"] = True
    winner["selectionReason"] = (
        f"Selected Lowest-Cost Query (Cost {winner['queryCost']} · Resilience {winner['resilienceScore']}): {winner['selectionReason']}"
    )

    for alt in evaluated[1:]:
        alt["selected"] = False
        if alt["execution"].get("error"):
            alt["selectionReason"] = f"Not Selected — Execution failed ({alt['execution']['error']})."
        else:
            cost_delta = round(alt["queryCost"] - winner["queryCost"], 2)
            if alt["anomalyPenalty"] > winner["anomalyPenalty"]:
                alt["selectionReason"] = (
                    f"Not Selected — Higher query cost ({alt['queryCost']} vs {winner['queryCost']}, +{cost_delta}) due to graph edge anomaly penalty ({alt['anomalyPenalty']} vs {winner['anomalyPenalty']})."
                )
            else:
                alt["selectionReason"] = (
                    f"Not Selected — Higher calculated query cost ({alt['queryCost']} vs {winner['queryCost']}, +{cost_delta})."
                )

    winning_plan = parse_sql_to_query_graph(winner["sql"], profile["tables"], profile["edges"])
    data_warnings: list[str] = []
    if winner["execution"].get("resultAnomalies"):
        data_warnings.extend(winner["execution"]["resultAnomalies"])
    if profile["totalAnomalies"] > 0:
        data_warnings.append(
            f"{profile['totalAnomalies']} active schema/data anomalies detected in database; cost model penalized corrupted edges."
        )

    llm_meta["failovers"] = all_failovers
    return {
        "mode": "database",
        "question": question,
        "selectedSql": winner["sql"],
        "explanation": str(parsed.get("explanation") or winner["selectionReason"]),
        "candidates": evaluated,
        "repairAttempts": repair_attempts,
        "totalAttempts": len(repair_attempts),
        "healedOnRetry": (
            len(repair_attempts) > 1 and repair_attempts[-1].get("status") == "success"
        ),
        "queryGraph": winning_plan,
        "result": winner["execution"],
        "dataWarnings": data_warnings,
        "llmMeta": llm_meta,
    }
