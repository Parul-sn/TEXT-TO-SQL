from __future__ import annotations

import email.parser
import email.policy
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .db_manager import (
    DbManager,
    apply_general_language_cleaning,
    clean_anomaly_in_db,
    execute_read_only_sql,
    get_table_preview_with_imputation,
    profile_sqlite_file,
)
from .env_loader import get_llm_configs, is_llm_configured, load_dotenv_file
from .llm_sql import generate_and_run_text_to_sql
from .graph_engine import parse_sql_to_query_graph
from .showcase_examples import SHOWCASE_EXAMPLES
from .spider_benchmark import (
    SpiderJobManager,
    download_official_spider_dataset,
    get_spider_dataset_info,
    load_official_spider_tasks,
)

load_dotenv_file()

db_manager = DbManager()
spider_jobs = SpiderJobManager()


def _get_session_id(headers: Any, query: str) -> str:
    raw = headers.get("x-session-id") or ""
    if not raw and query:
        for pair in query.split("&"):
            if pair.startswith("sessionId="):
                raw = unquote(pair.split("=", 1)[1])
                break
    raw = raw.strip() or "default"
    if re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", raw):
        return raw
    return "default"


def _parse_multipart_file(content_type: str, body: bytes) -> tuple[str, bytes]:
    header_block = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(header_block + body)
    if not msg.is_multipart():
        raise ValueError("Expected multipart/form-data upload payload.")
    for part in msg.iter_parts():
        filename = part.get_filename()
        if filename is not None:
            payload = part.get_payload(decode=True) or b""
            return filename, payload
    raise ValueError("No .sql or .db file uploaded.")


class GraphSqlHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress noisy per-request logs while retaining errors
        pass

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > 30 * 1024 * 1024:
            raise ValueError("Payload exceeds 30 MB limit.")
        return self.rfile.read(length)

    def _read_json(self) -> dict[str, Any]:
        raw = self._read_body()
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        session_id = _get_session_id(self.headers, parsed.query)

        try:
            if path == "/api/health":
                try:
                    configured_keys = len(get_llm_configs())
                    has_llm = configured_keys > 0
                except RuntimeError:
                    configured_keys = 0
                    has_llm = False
                info = get_spider_dataset_info()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "backend": "python",
                        "pythonVersion": sys.version.split()[0],
                        "llmConfigured": has_llm,
                        "configuredKeys": configured_keys,
                        "spiderDatasetReady": info["downloaded"],
                        "spiderTotalTasks": info["totalTasks"],
                    },
                )
                return

            if path == "/api/examples":
                clean_examples = [
                    {k: v for k, v in ex.items() if k != "sqlSeed"} for ex in SHOWCASE_EXAMPLES
                ]
                self._send_json(200, {"examples": clean_examples})
                return

            if path == "/api/db/state":
                sess = db_manager.get_or_create(session_id)
                profile = profile_sqlite_file(sess.db_path) if sess.db_path else None
                self._send_json(
                    200,
                    {
                        "mode": sess.mode,
                        "sourceName": sess.source_name,
                        "sourceKind": sess.source_kind,
                        "exampleId": sess.example_id,
                        "profile": profile,
                    },
                )
                return

            if path.startswith("/api/db/table/"):
                table_name = unquote(path[len("/api/db/table/") :])
                sess = db_manager.get_or_create(session_id)
                if not sess.db_path:
                    self._send_json(
                        400, {"error": "No database is currently loaded (Text-Only Mode)."}
                    )
                    return
                preview = get_table_preview_with_imputation(sess.db_path, table_name)
                self._send_json(200, preview)
                return

            if path == "/api/spider/info":
                self._send_json(200, get_spider_dataset_info())
                return

            if path == "/api/spider/tasks":
                qs = parse_qs(parsed.query)
                hardness_q = (qs.get("hardness", ["All"])[0] or "All").strip()
                search_q = (qs.get("search", [""])[0] or "").strip().lower()
                try:
                    page_num = max(1, int(qs.get("page", ["1"])[0]))
                except ValueError:
                    page_num = 1
                try:
                    page_size = max(1, min(100, int(qs.get("pageSize", ["25"])[0])))
                except ValueError:
                    page_size = 25

                tasks, _ = load_official_spider_tasks()
                filtered = tasks
                if hardness_q in ("Easy", "Medium", "Hard", "Extra Hard"):
                    filtered = [t for t in filtered if t["hardness"] == hardness_q]
                if search_q:
                    filtered = [
                        t
                        for t in filtered
                        if search_q in t["question"].lower()
                        or search_q in t["dbId"].lower()
                        or search_q in t["id"].lower()
                        or search_q in t["goldSql"].lower()
                    ]

                filtered_total = len(filtered)
                total_pages = max(1, (filtered_total + page_size - 1) // page_size)
                safe_page = min(page_num, total_pages)
                start_idx = (safe_page - 1) * page_size
                page_slice = filtered[start_idx : start_idx + page_size]

                slim = [
                    {
                        "id": t["id"],
                        "dbId": t["dbId"],
                        "dbName": t["dbName"],
                        "hardness": t["hardness"],
                        "question": t["question"],
                        "goldSql": t["goldSql"],
                    }
                    for t in page_slice
                ]
                self._send_json(
                    200,
                    {
                        "tasks": slim,
                        "totalAvailable": len(tasks),
                        "filteredTotal": filtered_total,
                        "page": safe_page,
                        "pageSize": page_size,
                        "totalPages": total_pages,
                    },
                )
                return

            if path == "/api/spider/status":
                self._send_json(200, spider_jobs.get_status())
                return

            self._send_json(404, {"error": f"Unknown GET endpoint: {path}"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        session_id = _get_session_id(self.headers, parsed.query)

        try:
            if path == "/api/db/load-example":
                body = self._read_json()
                ex_id = str(body.get("exampleId") or "ecommerce_multipath")
                sess = db_manager.load_example(session_id, ex_id)
                profile = profile_sqlite_file(sess.db_path) if sess.db_path else None
                self._send_json(
                    200,
                    {
                        "mode": sess.mode,
                        "sourceName": sess.source_name,
                        "sourceKind": sess.source_kind,
                        "exampleId": sess.example_id,
                        "profile": profile,
                    },
                )
                return

            if path == "/api/db/text-only":
                sess = db_manager.set_text_only(session_id)
                self._send_json(
                    200,
                    {
                        "mode": sess.mode,
                        "sourceName": sess.source_name,
                        "sourceKind": sess.source_kind,
                        "exampleId": sess.example_id,
                        "profile": None,
                    },
                )
                return

            if path == "/api/db/upload":
                ct = self.headers.get("Content-Type") or ""
                raw_body = self._read_body()
                filename, file_bytes = _parse_multipart_file(ct, raw_body)
                sess = db_manager.load_uploaded_file(session_id, filename, file_bytes)
                profile = profile_sqlite_file(sess.db_path) if sess.db_path else None
                self._send_json(
                    200,
                    {
                        "mode": sess.mode,
                        "sourceName": sess.source_name,
                        "sourceKind": sess.source_kind,
                        "profile": profile,
                    },
                )
                return

            if path == "/api/db/reset":
                sess = db_manager.reset_session(session_id)
                profile = profile_sqlite_file(sess.db_path) if sess.db_path else None
                self._send_json(
                    200,
                    {
                        "mode": sess.mode,
                        "sourceName": sess.source_name,
                        "sourceKind": sess.source_kind,
                        "exampleId": sess.example_id,
                        "profile": profile,
                    },
                )
                return

            if path == "/api/db/clean-anomaly":
                body = self._read_json()
                anomaly_id = str(body.get("anomalyId") or "")
                action_type = str(body.get("actionType") or "").strip() or None
                custom_instruction = str(body.get("customInstruction") or "").strip() or None
                sess = db_manager.get_or_create(session_id)
                if not sess.db_path:
                    self._send_json(400, {"error": "No database loaded."})
                    return
                if not anomaly_id:
                    self._send_json(400, {"error": "Missing anomalyId."})
                    return
                outcome = clean_anomaly_in_db(
                    sess.db_path,
                    anomaly_id,
                    action_type=action_type,
                    custom_instruction=custom_instruction,
                )
                sess.cleared_anomaly_ids.add(anomaly_id)
                profile = profile_sqlite_file(sess.db_path)
                self._send_json(200, {**outcome, "profile": profile})
                return

            if path == "/api/db/clean-custom":
                body = self._read_json()
                table_name = str(body.get("tableName") or "").strip()
                column_name = str(body.get("columnName") or "").strip()
                instruction = str(body.get("instruction") or "").strip()
                sess = db_manager.get_or_create(session_id)
                if not sess.db_path:
                    self._send_json(400, {"error": "No database loaded."})
                    return
                if not table_name or not column_name or not instruction:
                    self._send_json(
                        400,
                        {"error": "Please select a table, select a column, and enter an instruction."},
                    )
                    return
                outcome = apply_general_language_cleaning(
                    sess.db_path, table_name, column_name, instruction
                )
                profile = profile_sqlite_file(sess.db_path)
                self._send_json(200, {**outcome, "profile": profile})
                return

            if path == "/api/db/clean-all":
                sess = db_manager.get_or_create(session_id)
                if not sess.db_path:
                    self._send_json(400, {"error": "No database loaded."})
                    return
                initial = profile_sqlite_file(sess.db_path)
                applied_log: list[dict[str, str]] = []
                for anomaly in initial["anomalies"]:
                    try:
                        res_clean = clean_anomaly_in_db(sess.db_path, anomaly["id"])
                        applied_log.append({"id": anomaly["id"], **res_clean})
                    except Exception:
                        pass
                profile = profile_sqlite_file(sess.db_path)
                self._send_json(200, {"appliedLog": applied_log, "profile": profile})
                return

            if path == "/api/sql/generate":
                body = self._read_json()
                question = str(body.get("question") or "").strip()
                if not question:
                    self._send_json(400, {"error": "Please provide a natural-language question."})
                    return
                force_text_only = bool(body.get("forceTextOnly"))
                sess = db_manager.get_or_create(session_id)
                result = generate_and_run_text_to_sql(
                    question=question,
                    db_path=sess.db_path,
                    force_text_only=force_text_only,
                )
                self._send_json(200, result)
                return

            if path == "/api/sql/execute":
                body = self._read_json()
                sql = str(body.get("sql") or "").strip()
                if not sql:
                    self._send_json(400, {"error": "SQL query cannot be empty."})
                    return
                sess = db_manager.get_or_create(session_id)
                if not sess.db_path:
                    query_graph = parse_sql_to_query_graph(sql, [], [])
                    self._send_json(
                        200,
                        {
                            "execution": {
                                "columns": [],
                                "rows": [],
                                "rowCount": 0,
                                "executionMs": 0,
                            },
                            "queryGraph": query_graph,
                        },
                    )
                    return
                profile = profile_sqlite_file(sess.db_path)
                execution = execute_read_only_sql(
                    sess.db_path, sql, apply_imputation_overlay=True
                )
                query_graph = parse_sql_to_query_graph(
                    sql, profile["tables"], profile["edges"]
                )
                self._send_json(200, {"execution": execution, "queryGraph": query_graph})
                return

            if path == "/api/spider/download":
                info = download_official_spider_dataset()
                self._send_json(200, info)
                return

            if path == "/api/spider/start":
                body = self._read_json()
                count = body.get("count")
                offset = int(body.get("offset") or 0)
                hardness = str(body.get("hardness") or "All")
                task_ids = body.get("taskIds")
                status = spider_jobs.start_benchmark(
                    count=int(count) if count is not None else None,
                    offset=offset,
                    hardness=hardness,
                    task_ids=task_ids if isinstance(task_ids, list) else None,
                )
                self._send_json(200, status)
                return

            if path == "/api/spider/cancel":
                self._send_json(200, spider_jobs.cancel())
                return

            self._send_json(404, {"error": f"Unknown POST endpoint: {path}"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


def _watch_parent(parent_pid: int) -> None:
    while True:
        time.sleep(2.0)
        if os.getppid() != parent_pid:
            os._exit(0)


def main() -> None:
    port = int(os.environ.get("PYTHON_BACKEND_PORT") or 8765)
    parent_pid = os.getppid()
    if parent_pid > 1:
        threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), GraphSqlHandler)
    print(f"GraphSQL Python backend listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
