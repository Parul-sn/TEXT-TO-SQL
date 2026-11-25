from __future__ import annotations

import json
import math
import os
import re
import shutil
import threading
import time
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .db_manager import execute_read_only_sql
from .env_loader import load_dotenv_file
from .llm_sql import generate_and_run_text_to_sql

SPIDER_OFFICIAL_DOWNLOAD_URL = (
    "https://drive.usercontent.google.com/download?id=1403EGqzIDoHMdQF4c9Bkyl7dZLZ5Wt6J&export=download&confirm=t"
)

HARDNESS_LEVELS = ("Easy", "Medium", "Hard", "Extra Hard")


def resolve_spider_dir() -> Path:
    load_dotenv_file()
    configured = os.environ.get("SPIDER_DATA_DIR", "data/spider")
    candidates = [
        Path(configured),
        Path("data/spider"),
        Path("data/spider_data"),
    ]
    for p in candidates:
        if (p / "dev.json").exists() and (p / "database").exists():
            return p
    return Path(configured)


def classify_spider_hardness(item: dict[str, Any]) -> str:
    """Classify Spider query hardness from official parsed AST dict (`sql`) or SQL string."""
    sql_ast = item.get("sql")
    query_str = str(item.get("query") or "")
    if isinstance(sql_ast, dict):
        has_set_op = bool(sql_ast.get("intersect") or sql_ast.get("union") or sql_ast.get("except"))
        has_nested = False
        for cond in sql_ast.get("where") or []:
            if isinstance(cond, (list, tuple)) and len(cond) >= 4 and isinstance(cond[3], dict):
                has_nested = True
        for h_cond in sql_ast.get("having") or []:
            if isinstance(h_cond, (list, tuple)) and len(h_cond) >= 4 and isinstance(h_cond[3], dict):
                has_nested = True
        from_part = sql_ast.get("from") or {}
        table_units = from_part.get("table_units") or []
        for tu in table_units:
            if isinstance(tu, (list, tuple)) and len(tu) >= 2 and isinstance(tu[1], dict):
                has_nested = True

        if has_set_op or has_nested or len(table_units) >= 4:
            return "Extra Hard"

        agg_count = 0
        sel = sql_ast.get("select")
        if isinstance(sel, (list, tuple)) and len(sel) >= 2 and isinstance(sel[1], list):
            for val_unit in sel[1]:
                if isinstance(val_unit, (list, tuple)) and val_unit and val_unit[0] != 0:
                    agg_count += 1
        has_group = bool(sql_ast.get("groupBy"))
        has_having = bool(sql_ast.get("having"))
        has_order = bool(sql_ast.get("orderBy"))
        has_limit = sql_ast.get("limit") is not None
        where_count = sum(1 for c in (sql_ast.get("where") or []) if isinstance(c, (list, tuple)))

        complexity = (
            (len(table_units) - 1) * 2
            + (1 if has_group else 0)
            + (2 if has_having else 0)
            + (1 if has_order or has_limit else 0)
            + agg_count
            + where_count
        )
        if complexity >= 5:
            return "Hard"
        if complexity >= 2:
            return "Medium"
        return "Easy"

    upper = query_str.upper()
    if any(k in upper for k in ("INTERSECT", "UNION", "EXCEPT")) or upper.count("SELECT") > 1:
        return "Extra Hard"
    if upper.count(" JOIN ") >= 2 or "HAVING" in upper:
        return "Hard"
    if any(k in upper for k in ("GROUP BY", "ORDER BY", " JOIN ")):
        return "Medium"
    return "Easy"


def _normalize_cell(val: Any) -> str:
    if val is None:
        return "NULL"
    if isinstance(val, bool):
        return "1" if val else "0"
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        if math.isnan(val):
            return "NULL"
        if val.is_integer():
            return str(int(val))
        return str(round(val, 3))
    s = str(val).strip()
    if s != "":
        try:
            num = float(s)
            if math.isfinite(num):
                return str(int(num)) if num.is_integer() else str(round(num, 3))
        except ValueError:
            pass
    return s.lower()


def compare_execution_results(
    gold: dict[str, Any],
    predicted: dict[str, Any],
    order_sensitive: bool,
) -> bool:
    gold_rows = gold.get("rows") or []
    pred_rows = predicted.get("rows") or []
    gold_cols = gold.get("columns") or []
    pred_cols = predicted.get("columns") or []

    if len(gold_rows) != len(pred_rows):
        return False
    if len(gold_rows) == 0 and len(pred_rows) == 0:
        return True
    if len(gold_cols) != len(pred_cols):
        return False

    def row_to_tuple(row: dict[str, Any], cols: list[str]) -> tuple[str, ...]:
        return tuple(_normalize_cell(row.get(c)) for c in cols)

    gold_tuples = [row_to_tuple(r, gold_cols) for r in gold_rows]
    pred_tuples = [row_to_tuple(r, pred_cols) for r in pred_rows]

    if order_sensitive:
        return gold_tuples == pred_tuples
    return sorted(gold_tuples) == sorted(pred_tuples)


def _tokenize_clauses(sql: str) -> set[str]:
    norm = re.sub(r'["`\[\]]', "", sql.lower())
    norm = re.sub(r";+$", "", norm)
    norm = re.sub(r"\s+", " ", norm).strip()
    tokens = [t.strip() for t in re.split(r"[\s,()=<>!+*/-]+", norm) if t.strip() and t.strip() != "as"]
    return set(tokens)


def compute_component_match_f1(gold_sql: str, predicted_sql: str) -> float:
    gold_toks = _tokenize_clauses(gold_sql)
    pred_toks = _tokenize_clauses(predicted_sql)
    if not gold_toks and not pred_toks:
        return 1.0
    if not gold_toks or not pred_toks:
        return 0.0
    overlap = sum(1 for t in pred_toks if t in gold_toks)
    precision = overlap / len(pred_toks)
    recall = overlap / len(gold_toks)
    if precision + recall == 0:
        return 0.0
    return round((2.0 * precision * recall) / (precision + recall), 3)


def download_official_spider_dataset(target_dir: str | Path = "data/spider") -> dict[str, Any]:
    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)
    zip_path = target.parent / "spider_data_download.zip"

    req = urllib.request.Request(
        SPIDER_OFFICIAL_DOWNLOAD_URL,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp, zip_path.open("wb") as out:
        shutil.copyfileobj(resp, out)

    extract_tmp = target.parent / "_spider_extract_tmp"
    if extract_tmp.exists():
        shutil.rmtree(extract_tmp)
    extract_tmp.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.namelist():
            if member.startswith("__MACOSX"):
                continue
            if (
                member.endswith(("dev.json", "tables.json", "dev_gold.sql"))
                or "/database/" in member
            ):
                zf.extract(member, extract_tmp)

    source_root = extract_tmp / "spider_data"
    if not source_root.exists():
        source_root = extract_tmp

    for name in ("dev.json", "tables.json", "dev_gold.sql", "database"):
        src = source_root / name
        dst = target / name
        if src.exists():
            if dst.exists():
                if dst.is_dir():
                    shutil.rmtree(dst)
                else:
                    dst.unlink()
            shutil.move(str(src), str(dst))

    if extract_tmp.exists():
        shutil.rmtree(extract_tmp)
    if zip_path.exists():
        zip_path.unlink()

    return get_spider_dataset_info()


def load_official_spider_tasks() -> tuple[list[dict[str, Any]], dict[str, int]]:
    spider_dir = resolve_spider_dir()
    dev_path = spider_dir / "dev.json"
    if not dev_path.exists():
        return [], {lvl: 0 for lvl in HARDNESS_LEVELS}

    raw_items = json.loads(dev_path.read_text(encoding="utf-8"))
    db_root = spider_dir / "database"
    tasks: list[dict[str, Any]] = []
    counts = {lvl: 0 for lvl in HARDNESS_LEVELS}

    for idx, item in enumerate(raw_items):
        db_id = str(item.get("db_id") or "")
        db_file = db_root / db_id / f"{db_id}.sqlite"
        if not db_file.exists():
            continue
        hardness = classify_spider_hardness(item)
        counts[hardness] = counts.get(hardness, 0) + 1
        tasks.append(
            {
                "id": f"spider_dev_{idx + 1:04d}",
                "index": idx + 1,
                "dbId": db_id,
                "dbName": db_id.replace("_", " ").title(),
                "dbPath": str(db_file),
                "hardness": hardness,
                "question": str(item.get("question") or ""),
                "goldSql": str(item.get("query") or ""),
            }
        )
    return tasks, counts


def get_spider_dataset_info() -> dict[str, Any]:
    spider_dir = resolve_spider_dir()
    tasks, counts = load_official_spider_tasks()
    unique_dbs = sorted({t["dbId"] for t in tasks})
    preview = [
        {
            "id": t["id"],
            "dbId": t["dbId"],
            "dbName": t["dbName"],
            "hardness": t["hardness"],
            "question": t["question"],
            "goldSql": t["goldSql"],
        }
        for t in tasks[:60]
    ]
    return {
        "downloaded": len(tasks) > 0,
        "datasetDir": str(spider_dir),
        "datasetName": "Yale Official Spider 1.0 Dev Split",
        "totalTasks": len(tasks),
        "totalDatabases": len(unique_dbs),
        "hardnessCounts": counts,
        "previewTasks": preview,
    }


def _build_summary(results: list[dict[str, Any]], total_target: int) -> dict[str, Any]:
    executed = len(results)
    passed = sum(1 for r in results if r["executionMatch"])
    first_pass = sum(1 for r in results if r["executionMatch"] and not r["healedOnRetry"])
    healed = sum(1 for r in results if r["executionMatch"] and r["healedOnRetry"])

    by_hardness = {lvl: {"total": 0, "passed": 0, "accuracy": 0.0} for lvl in HARDNESS_LEVELS}
    for r in results:
        lvl = r["hardness"]
        if lvl in by_hardness:
            by_hardness[lvl]["total"] += 1
            if r["executionMatch"]:
                by_hardness[lvl]["passed"] += 1

    for stats in by_hardness.values():
        stats["accuracy"] = round((stats["passed"] / stats["total"]) * 100, 1) if stats["total"] else 0.0

    avg_f1 = round((sum(r["componentMatchF1"] for r in results) / executed) * 100, 1) if executed else 0.0
    avg_latency = round(sum(r["executionMs"] for r in results) / executed, 1) if executed else 0.0
    costs = [float(r["queryCost"]) for r in results if r.get("queryCost") is not None]
    avg_cost = round(sum(costs) / len(costs), 2) if costs else 0.0
    failover_events: list[str] = []
    seen_f: set[str] = set()
    for r in results:
        for ev in r.get("_failovers") or []:
            if ev not in seen_f:
                seen_f.add(ev)
                failover_events.append(ev)

    clean_results = [{k: v for k, v in r.items() if k != "_failovers"} for r in results]

    return {
        "totalTasks": total_target,
        "executedTasks": executed,
        "executionAccuracy": round((passed / executed) * 100, 1) if executed else 0.0,
        "firstPassAccuracy": round((first_pass / executed) * 100, 1) if executed else 0.0,
        "healedAccuracy": round((healed / executed) * 100, 1) if executed else 0.0,
        "avgComponentF1": avg_f1,
        "avgLatencyMs": avg_latency,
        "avgQueryCost": avg_cost,
        "failoverEvents": failover_events,
        "byHardness": by_hardness,
        "results": clean_results,
    }


def _evaluate_single_spider_task(task: dict[str, Any]) -> dict[str, Any]:
    db_path = task["dbPath"]
    gold_exec = execute_read_only_sql(db_path, task["goldSql"], apply_imputation_overlay=False)
    order_sensitive = "ORDER BY" in task["goldSql"].upper()
    start = time.perf_counter()

    try:
        generated = generate_and_run_text_to_sql(
            question=task["question"],
            db_path=db_path,
            force_text_only=False,
            max_candidates=2,
            apply_imputation_overlay=False,
        )
        elapsed_ms = round((time.perf_counter() - start) * 1000.0, 1)
        pred_exec = execute_read_only_sql(
            db_path, generated["selectedSql"], apply_imputation_overlay=False
        )
        matched = (
            not gold_exec.get("error")
            and not pred_exec.get("error")
            and compare_execution_results(gold_exec, pred_exec, order_sensitive)
        )
        f1 = compute_component_match_f1(task["goldSql"], generated["selectedSql"])
        cands = generated.get("candidates") or []
        winner = next((c for c in cands if c.get("selected")), cands[0] if cands else {})
        llm_meta = generated.get("llmMeta") or {}
        return {
            "taskId": task["id"],
            "dbId": task["dbId"],
            "hardness": task["hardness"],
            "question": task["question"],
            "goldSql": task["goldSql"],
            "predictedSql": generated["selectedSql"],
            "executionMatch": matched,
            "componentMatchF1": f1,
            "attemptsUsed": generated["totalAttempts"],
            "healedOnRetry": generated["healedOnRetry"],
            "executionMs": elapsed_ms,
            "goldRowCount": gold_exec.get("rowCount", 0),
            "predictedRowCount": pred_exec.get("rowCount", 0),
            "queryCost": winner.get("queryCost"),
            "keySlot": llm_meta.get("keySlot", 1),
            "_failovers": list(llm_meta.get("failovers") or []),
            "error": pred_exec.get("error"),
        }
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - start) * 1000.0, 1)
        return {
            "taskId": task["id"],
            "dbId": task["dbId"],
            "hardness": task["hardness"],
            "question": task["question"],
            "goldSql": task["goldSql"],
            "predictedSql": "",
            "executionMatch": False,
            "componentMatchF1": 0.0,
            "attemptsUsed": 0,
            "healedOnRetry": False,
            "executionMs": elapsed_ms,
            "goldRowCount": gold_exec.get("rowCount", 0),
            "predictedRowCount": 0,
            "error": str(exc),
        }


class SpiderJobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._state: dict[str, Any] = {
            "jobId": None,
            "status": "idle",  # idle | running | completed | cancelled | error
            "completed": 0,
            "total": 0,
            "error": None,
            "activeKeySlot": 1,
            "configuredKeys": 0,
            "failoverEvents": [],
            "summary": None,
        }

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._state))

    def cancel(self) -> dict[str, Any]:
        self._cancel_event.set()
        with self._lock:
            if self._state["status"] == "running":
                self._state["status"] = "cancelled"
            return json.loads(json.dumps(self._state))

    def start_benchmark(
        self,
        count: int | None = None,
        offset: int = 0,
        hardness: str = "All",
        task_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        from .env_loader import get_llm_configs

        configs = get_llm_configs()
        all_tasks, _ = load_official_spider_tasks()
        if not all_tasks:
            raise RuntimeError(
                "Official Spider dataset not found locally. Click 'Download Official Spider Dataset' first."
            )

        if task_ids:
            wanted = set(task_ids)
            selected = [t for t in all_tasks if t["id"] in wanted]
        else:
            pool = (
                all_tasks
                if hardness == "All"
                else [t for t in all_tasks if t["hardness"] == hardness]
            )
            safe_offset = max(0, min(offset, len(pool)))
            safe_count = max(1, min(int(count or 10), len(pool) - safe_offset))
            selected = pool[safe_offset : safe_offset + safe_count]

        if not selected:
            raise ValueError("No Spider tasks match the requested count/filter.")

        self._cancel_event.set()
        time.sleep(0.05)
        self._cancel_event = threading.Event()
        cancel_ev = self._cancel_event

        job_id = f"spjob_{uuid.uuid4().hex[:8]}"
        with self._lock:
            self._state = {
                "jobId": job_id,
                "status": "running",
                "completed": 0,
                "total": len(selected),
                "error": None,
                "activeKeySlot": configs[0].slot,
                "configuredKeys": len(configs),
                "failoverEvents": [],
                "summary": _build_summary([], len(selected)),
            }

        def _worker() -> None:
            results_map: dict[int, dict[str, Any]] = {}
            try:
                workers = 1 if len(selected) <= 1 else min(2, len(selected))
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {
                        executor.submit(_evaluate_single_spider_task, t): idx
                        for idx, t in enumerate(selected)
                    }
                    for fut in as_completed(futures):
                        if cancel_ev.is_set():
                            break
                        idx = futures[fut]
                        res = fut.result()
                        results_map[idx] = res
                        ordered_results = [results_map[k] for k in sorted(results_map.keys())]
                        summary = _build_summary(ordered_results, len(selected))
                        with self._lock:
                            if self._state["jobId"] == job_id:
                                self._state["completed"] = len(ordered_results)
                                if res.get("keySlot"):
                                    self._state["activeKeySlot"] = res["keySlot"]
                                self._state["failoverEvents"] = summary.get("failoverEvents", [])
                                self._state["summary"] = summary
                with self._lock:
                    if self._state["jobId"] == job_id:
                        self._state["status"] = "cancelled" if cancel_ev.is_set() else "completed"
            except Exception as exc:
                with self._lock:
                    if self._state["jobId"] == job_id:
                        self._state["status"] = "error"
                        self._state["error"] = str(exc)

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        return self.get_status()
