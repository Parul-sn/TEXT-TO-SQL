from __future__ import annotations

import shutil
import sqlite3
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .data_quality import (
    detect_casing_and_whitespace_anomalies,
    detect_numeric_outliers,
    impute_missing_values,
    is_missing_value,
    parse_general_language_cleaning_rule,
)
from .showcase_examples import SHOWCASE_EXAMPLES


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _to_title_case(val: str) -> str:
    return " ".join(w[0].upper() + w[1:].lower() if w else w for w in val.split(" "))


@dataclass
class WorkspaceSession:
    session_id: str
    mode: str  # 'database' | 'text_only'
    source_name: str
    source_kind: str  # 'example' | 'sql_file' | 'db_file' | 'text_only'
    example_id: str | None
    db_path: Path | None = None
    snapshot_path: Path | None = None
    cleared_anomaly_ids: set[str] = field(default_factory=set)


class DbManager:
    def __init__(self) -> None:
        self._sessions: dict[str, WorkspaceSession] = {}
        self._lock = threading.Lock()
        self._tmp_root = Path(tempfile.gettempdir()) / "graphsql_sessions"
        self._tmp_root.mkdir(parents=True, exist_ok=True)

    def _session_dir(self, session_id: str) -> Path:
        safe = "".join(c for c in session_id if c.isalnum() or c in ("_", "-"))[:64] or "default"
        d = self._tmp_root / safe
        d.mkdir(parents=True, exist_ok=True)
        return d

    def get_or_create(self, session_id: str) -> WorkspaceSession:
        with self._lock:
            sess = self._sessions.get(session_id)
        if sess is not None:
            return sess
        return self.load_example(session_id, "ecommerce_multipath")

    def load_example(self, session_id: str, example_id: str) -> WorkspaceSession:
        seed = next((e for e in SHOWCASE_EXAMPLES if e["id"] == example_id), SHOWCASE_EXAMPLES[0])
        sdir = self._session_dir(session_id)

        if seed["mode"] == "text_only":
            sess = WorkspaceSession(
                session_id=session_id,
                mode="text_only",
                source_name="Text-Only Mode (No DB Attached)",
                source_kind="text_only",
                example_id=seed["id"],
            )
            with self._lock:
                self._sessions[session_id] = sess
            return sess

        db_file = sdir / "active.sqlite"
        snap_file = sdir / "snapshot.sqlite"
        if db_file.exists():
            db_file.unlink()
        if snap_file.exists():
            snap_file.unlink()

        conn = sqlite3.connect(str(db_file))
        try:
            conn.execute("PRAGMA foreign_keys = OFF;")
            conn.executescript(seed["sqlSeed"])
            conn.commit()
        finally:
            conn.close()

        shutil.copy2(db_file, snap_file)
        sess = WorkspaceSession(
            session_id=session_id,
            mode="database",
            source_name=seed["title"],
            source_kind="example",
            example_id=seed["id"],
            db_path=db_file,
            snapshot_path=snap_file,
        )
        with self._lock:
            self._sessions[session_id] = sess
        return sess

    def load_uploaded_file(
        self, session_id: str, filename: str, raw_bytes: bytes
    ) -> WorkspaceSession:
        lower = filename.lower()
        sdir = self._session_dir(session_id)
        db_file = sdir / "active.sqlite"
        snap_file = sdir / "snapshot.sqlite"
        if db_file.exists():
            db_file.unlink()
        if snap_file.exists():
            snap_file.unlink()

        if lower.endswith((".db", ".sqlite", ".sqlite3")):
            db_file.write_bytes(raw_bytes)
            # Validate SQLite integrity
            conn = sqlite3.connect(str(db_file))
            try:
                conn.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1;").fetchall()
            finally:
                conn.close()
            source_kind = "db_file"
        elif lower.endswith(".sql"):
            sql_text = raw_bytes.decode("utf-8", errors="replace")
            conn = sqlite3.connect(str(db_file))
            try:
                conn.execute("PRAGMA foreign_keys = OFF;")
                conn.executescript(sql_text)
                conn.commit()
            finally:
                conn.close()
            source_kind = "sql_file"
        else:
            raise ValueError(
                "Unsupported file format. Please upload a .sql, .db, .sqlite, or .sqlite3 file."
            )

        shutil.copy2(db_file, snap_file)
        sess = WorkspaceSession(
            session_id=session_id,
            mode="database",
            source_name=filename,
            source_kind=source_kind,
            example_id=None,
            db_path=db_file,
            snapshot_path=snap_file,
        )
        with self._lock:
            self._sessions[session_id] = sess
        return sess

    def reset_session(self, session_id: str) -> WorkspaceSession:
        sess = self.get_or_create(session_id)
        if sess.db_path and sess.snapshot_path and sess.snapshot_path.exists():
            shutil.copy2(sess.snapshot_path, sess.db_path)
            sess.cleared_anomaly_ids.clear()
        return sess

    def set_text_only(self, session_id: str) -> WorkspaceSession:
        return self.load_example(session_id, "text_only_mode")


def _query_rows(conn: sqlite3.Connection, sql: str) -> tuple[list[str], list[dict[str, Any]]]:
    cur = conn.execute(sql)
    cols = [d[0] for d in cur.description] if cur.description else []
    raw_rows = cur.fetchall()
    rows = [{cols[i]: row[i] for i in range(len(cols))} for row in raw_rows]
    return cols, rows


def profile_sqlite_file(db_path: str | Path) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path))
    try:
        return profile_connection(conn)
    finally:
        conn.close()


def profile_connection(conn: sqlite3.Connection) -> dict[str, Any]:
    _, table_list = _query_rows(
        conn,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid;",
    )
    tables: list[dict[str, Any]] = []
    raw_edges: list[dict[str, Any]] = []
    all_imputed_cells: list[dict[str, Any]] = []
    all_anomalies: list[dict[str, Any]] = []
    table_rows_cache: dict[str, list[dict[str, Any]]] = {}

    total_rows = 0
    total_missing_cells = 0

    for t_row in table_list:
        table_name = str(t_row["name"])
        safe_tbl = quote_ident(table_name)
        _, info_rows = _query_rows(conn, f"PRAGMA table_info({safe_tbl});")
        _, fk_rows = _query_rows(conn, f"PRAGMA foreign_key_list({safe_tbl});")
        _, all_data = _query_rows(conn, f"SELECT * FROM {safe_tbl};")

        table_rows_cache[table_name] = all_data
        total_rows += len(all_data)

        fk_map: dict[str, dict[str, str]] = {}
        for fk in fk_rows:
            from_col = str(fk.get("from", ""))
            to_table = str(fk.get("table", ""))
            to_col = str(fk.get("to") or "id")
            if from_col and to_table:
                fk_map[from_col] = {"toTable": to_table, "toColumn": to_col}

        columns: list[dict[str, Any]] = []
        for col_row in info_rows:
            col_name = str(col_row["name"])
            col_type = str(col_row.get("type") or "TEXT")
            is_pk = int(col_row.get("pk") or 0) > 0
            fk = fk_map.get(col_name)
            missing_cnt = sum(1 for r in all_data if is_missing_value(r.get(col_name)))
            total_missing_cells += missing_cnt
            missing_rate = round(missing_cnt / len(all_data), 3) if all_data else 0.0
            columns.append(
                {
                    "name": col_name,
                    "type": col_type,
                    "isPrimaryKey": is_pk,
                    "isForeignKey": fk is not None,
                    "referencesTable": fk["toTable"] if fk else None,
                    "referencesColumn": fk["toColumn"] if fk else None,
                    "nullable": int(col_row.get("notnull") or 0) == 0,
                    "missingCount": missing_cnt,
                    "missingRate": missing_rate,
                    "anomalyCount": 0,
                }
            )

        for col in columns:
            if col["isPrimaryKey"]:
                continue
            outlier = detect_numeric_outliers(all_data, table_name, col["name"])
            if outlier:
                all_anomalies.append(outlier)
                col["anomalyCount"] += outlier["affectedRowCount"]
            casing = detect_casing_and_whitespace_anomalies(all_data, table_name, col["name"])
            if casing:
                all_anomalies.append(casing)
                col["anomalyCount"] += casing["affectedRowCount"]

        pk_col = next((c["name"] for c in columns if c["isPrimaryKey"]), None)
        _, imputed_cells = impute_missing_values(table_name, all_data, columns, pk_col)
        all_imputed_cells.extend(imputed_cells)

        for col in columns:
            if col["isForeignKey"] and col["referencesTable"] and col["referencesColumn"]:
                raw_edges.append(
                    {
                        "id": f"fk_{table_name}_{col['name']}_{col['referencesTable']}_{col['referencesColumn']}",
                        "fromTable": table_name,
                        "fromColumn": col["name"],
                        "toTable": col["referencesTable"],
                        "toColumn": col["referencesColumn"],
                        "inferred": False,
                        "orphanCount": 0,
                        "missingRate": col["missingRate"],
                        "anomalyPenalty": 0.0,
                    }
                )

        tables.append(
            {
                "name": table_name,
                "rowCount": len(all_data),
                "columns": columns,
            }
        )

    existing_keys = {
        f"{e['fromTable']}.{e['fromColumn']}->{e['toTable']}.{e['toColumn']}" for e in raw_edges
    }
    for t in tables:
        for col in t["columns"]:
            if col["isPrimaryKey"] or col["isForeignKey"]:
                continue
            cname_l = col["name"].lower()
            if not cname_l.endswith("_id") and not cname_l.endswith("_uid"):
                continue
            for target in tables:
                if target["name"] == t["name"]:
                    continue
                target_pk = next((c for c in target["columns"] if c["isPrimaryKey"]), None)
                if target_pk and (
                    target_pk["name"].lower() == cname_l
                    or cname_l == f"{target['name'].lower().rstrip('s')}_id"
                ):
                    edge_key = f"{t['name']}.{col['name']}->{target['name']}.{target_pk['name']}"
                    if edge_key not in existing_keys:
                        col["isForeignKey"] = True
                        col["referencesTable"] = target["name"]
                        col["referencesColumn"] = target_pk["name"]
                        raw_edges.append(
                            {
                                "id": f"inferred_{t['name']}_{col['name']}_{target['name']}_{target_pk['name']}",
                                "fromTable": t["name"],
                                "fromColumn": col["name"],
                                "toTable": target["name"],
                                "toColumn": target_pk["name"],
                                "inferred": True,
                                "orphanCount": 0,
                                "missingRate": col["missingRate"],
                                "anomalyPenalty": 0.0,
                            }
                        )

    for edge in raw_edges:
        child_rows = table_rows_cache.get(edge["fromTable"], [])
        parent_rows = table_rows_cache.get(edge["toTable"], [])
        parent_ids = {
            str(r.get(edge["toColumn"]))
            for r in parent_rows
            if not is_missing_value(r.get(edge["toColumn"]))
        }
        orphan_vals: list[str] = []
        for r in child_rows:
            val = r.get(edge["fromColumn"])
            if is_missing_value(val):
                continue
            if str(val) not in parent_ids:
                orphan_vals.append(str(val))

        edge["orphanCount"] = len(orphan_vals)
        orphan_rate = len(orphan_vals) / len(child_rows) if child_rows else 0.0
        edge["anomalyPenalty"] = round(
            min(1.0, orphan_rate * 2.2 + edge["missingRate"] * 1.1), 3
        )

        if orphan_vals:
            tbl_obj = next((t for t in tables if t["name"] == edge["fromTable"]), None)
            if tbl_obj:
                col_obj = next(
                    (c for c in tbl_obj["columns"] if c["name"] == edge["fromColumn"]), None
                )
                if col_obj:
                    col_obj["anomalyCount"] += len(orphan_vals)
            unique_samples = list(dict.fromkeys(orphan_vals))[:4]
            all_anomalies.append(
                {
                    "id": f"orphan_{edge['fromTable']}_{edge['fromColumn']}",
                    "kind": "orphan_foreign_key",
                    "severity": "high",
                    "tableName": edge["fromTable"],
                    "columnName": edge["fromColumn"],
                    "affectedRowCount": len(orphan_vals),
                    "sampleValues": unique_samples,
                    "description": (
                        f"{len(orphan_vals)} row(s) in {edge['fromTable']}.{edge['fromColumn']} "
                        f"reference non-existent {edge['toTable']}.{edge['toColumn']} keys ({', '.join(unique_samples)})."
                    ),
                    "recommendedAction": (
                        f"Nullify orphan foreign keys in {edge['fromTable']}.{edge['fromColumn']} or delete broken child rows."
                    ),
                    "cleanActionType": "remove_orphan_fk",
                    "cleaningOptions": [
                        {
                            "id": "remove_orphan_fk",
                            "label": "Set Orphan Keys to NULL",
                            "description": f"Keep {len(orphan_vals)} row(s) in {edge['fromTable']} while setting invalid {edge['fromColumn']} keys to NULL.",
                            "recommended": True,
                        },
                        {
                            "id": "delete_rows",
                            "label": "Delete Orphan Rows",
                            "description": f"Delete {len(orphan_vals)} child row(s) referencing missing {edge['toTable']}.{edge['toColumn']} keys.",
                        },
                    ],
                    "cleared": False,
                }
            )

    return {
        "tables": tables,
        "edges": raw_edges,
        "totalRows": total_rows,
        "totalMissingCells": total_missing_cells,
        "totalAnomalies": len(all_anomalies),
        "imputedCells": all_imputed_cells,
        "anomalies": all_anomalies,
    }


def get_table_preview_with_imputation(db_path: Path, table_name: str) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path))
    try:
        profile = profile_connection(conn)
        table_schema = next(
            (t for t in profile["tables"] if t["name"].lower() == table_name.lower()), None
        )
        if not table_schema:
            raise ValueError(f'Table "{table_name}" not found.')
        _, rows = _query_rows(conn, f"SELECT * FROM {quote_ident(table_schema['name'])} LIMIT 200;")
        pk_col = next((c["name"] for c in table_schema["columns"] if c["isPrimaryKey"]), None)
        imputed_rows, imputed_cells = impute_missing_values(
            table_schema["name"], rows, table_schema["columns"], pk_col
        )
        return {
            "columns": table_schema["columns"],
            "originalRows": rows,
            "imputedRows": imputed_rows,
            "imputedCells": imputed_cells,
        }
    finally:
        conn.close()


def _execute_cleaning_plan_on_conn(
    conn: sqlite3.Connection,
    profile: dict[str, Any],
    table_name: str,
    column_name: str,
    plan: dict[str, Any],
) -> dict[str, str]:
    tbl = quote_ident(table_name)
    col = quote_ident(column_name)
    kind = plan["actionKind"]

    def _compute_iqr_bounds() -> tuple[float, float, int]:
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, * FROM {tbl};")
        nums: list[float] = []
        for r in rows:
            v = r.get(column_name)
            if not is_missing_value(v):
                try:
                    nums.append(float(v))
                except (TypeError, ValueError):
                    pass
        nums.sort()
        q1 = nums[int(len(nums) * 0.25)] if nums else 0.0
        q3 = nums[int(len(nums) * 0.75)] if nums else 0.0
        iqr = q3 - q1
        lower = max(0.0, q1 - 1.5 * iqr)
        upper = q3 + 1.5 * iqr
        return lower, upper, len(nums)

    if kind in ("normalize_title", "normalize_upper", "normalize_lower", "trim_whitespace"):
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        updated = 0
        for r in rows:
            val = r.get("val")
            if not isinstance(val, str) or is_missing_value(val):
                continue
            collapsed = " ".join(val.strip().split())
            if kind == "normalize_title":
                normalized = _to_title_case(collapsed)
            elif kind == "normalize_upper":
                normalized = collapsed.upper()
            elif kind == "normalize_lower":
                normalized = collapsed.lower()
            else:
                normalized = collapsed
            if normalized != val:
                conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (normalized, r["__rid"]))
                updated += 1
        conn.commit()
        fn_label = {
            "normalize_title": "TRIM_AND_TITLECASE",
            "normalize_upper": "TRIM_AND_UPPER",
            "normalize_lower": "TRIM_AND_LOWER",
            "trim_whitespace": "TRIM_WHITESPACE",
        }[kind]
        return {
            "appliedSql": f"UPDATE {tbl} SET {col} = {fn_label}({col}); -- {updated} row(s) updated",
            "message": f"{plan['description']} ({updated} row(s) updated in {table_name}.{column_name}).",
        }

    if kind in ("nullify_orphan_fk", "delete_orphan_fk"):
        edge = next(
            (e for e in profile["edges"] if e["fromTable"] == table_name and e["fromColumn"] == column_name),
            None,
        )
        if not edge:
            raise ValueError(f"No foreign-key relationship found on {table_name}.{column_name}.")
        target_tbl = quote_ident(edge["toTable"])
        target_col = quote_ident(edge["toColumn"])
        if kind == "delete_orphan_fk":
            sql = (
                f"DELETE FROM {tbl} WHERE {col} IS NOT NULL "
                f"AND {col} NOT IN (SELECT {target_col} FROM {target_tbl} WHERE {target_col} IS NOT NULL);"
            )
            cur = conn.execute(sql)
            conn.commit()
            return {
                "appliedSql": sql,
                "message": f"Deleted {cur.rowcount} orphan foreign-key row(s) from {table_name}.",
            }
        sql = (
            f"UPDATE {tbl} SET {col} = NULL WHERE {col} IS NOT NULL "
            f"AND {col} NOT IN (SELECT {target_col} FROM {target_tbl} WHERE {target_col} IS NOT NULL);"
        )
        cur = conn.execute(sql)
        conn.commit()
        return {
            "appliedSql": sql,
            "message": f"Nullified {cur.rowcount} orphan foreign-key reference(s) in {table_name}.{column_name}.",
        }

    if kind == "set_negative_to":
        rep = plan.get("replacementValue", 0)
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        updated = 0
        for r in rows:
            v = r.get("val")
            if is_missing_value(v):
                continue
            try:
                if float(v) < 0:
                    conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (rep, r["__rid"]))
                    updated += 1
            except (TypeError, ValueError):
                pass
        conn.commit()
        return {
            "appliedSql": f"UPDATE {tbl} SET {col} = {rep!r} WHERE CAST({col} AS REAL) < 0; -- {updated} row(s)",
            "message": f"Replaced {updated} negative value(s) in {table_name}.{column_name} with {rep}.",
        }

    if kind == "abs_negative":
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        updated = 0
        for r in rows:
            v = r.get("val")
            if is_missing_value(v):
                continue
            try:
                num = float(v)
                if num < 0:
                    pos = int(abs(num)) if isinstance(v, int) or float(abs(num)).is_integer() else round(abs(num), 4)
                    conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (pos, r["__rid"]))
                    updated += 1
            except (TypeError, ValueError):
                pass
        conn.commit()
        return {
            "appliedSql": f"UPDATE {tbl} SET {col} = ABS({col}) WHERE CAST({col} AS REAL) < 0; -- {updated} row(s)",
            "message": f"Converted {updated} negative value(s) in {table_name}.{column_name} to positive.",
        }

    if kind == "delete_negative":
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        deleted = 0
        for r in rows:
            v = r.get("val")
            if is_missing_value(v):
                continue
            try:
                if float(v) < 0:
                    conn.execute(f"DELETE FROM {tbl} WHERE rowid = ?;", (r["__rid"],))
                    deleted += 1
            except (TypeError, ValueError):
                pass
        conn.commit()
        return {
            "appliedSql": f"DELETE FROM {tbl} WHERE CAST({col} AS REAL) < 0; -- {deleted} row(s)",
            "message": f"Deleted {deleted} row(s) with negative {table_name}.{column_name}.",
        }

    if kind == "nullify_negative":
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        updated = 0
        for r in rows:
            v = r.get("val")
            if is_missing_value(v):
                continue
            try:
                if float(v) < 0:
                    conn.execute(f"UPDATE {tbl} SET {col} = NULL WHERE rowid = ?;", (r["__rid"],))
                    updated += 1
            except (TypeError, ValueError):
                pass
        conn.commit()
        return {
            "appliedSql": f"UPDATE {tbl} SET {col} = NULL WHERE CAST({col} AS REAL) < 0; -- {updated} row(s)",
            "message": f"Set {updated} negative value(s) in {table_name}.{column_name} to NULL.",
        }

    if kind in ("cap_above", "delete_above", "nullify_above", "floor_below", "delete_below", "nullify_below"):
        thr = float(plan.get("threshold", 0))
        is_above = kind.endswith("_above")
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        touched = 0
        for r in rows:
            v = r.get("val")
            if is_missing_value(v):
                continue
            try:
                num = float(v)
            except (TypeError, ValueError):
                continue
            hit = num > thr if is_above else num < thr
            if not hit:
                continue
            if kind.startswith("delete_"):
                conn.execute(f"DELETE FROM {tbl} WHERE rowid = ?;", (r["__rid"],))
            elif kind.startswith("nullify_"):
                conn.execute(f"UPDATE {tbl} SET {col} = NULL WHERE rowid = ?;", (r["__rid"],))
            else:
                conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (plan.get("replacementValue", thr), r["__rid"]))
            touched += 1
        conn.commit()
        op_sym = ">" if is_above else "<"
        if kind.startswith("delete_"):
            applied = f"DELETE FROM {tbl} WHERE CAST({col} AS REAL) {op_sym} {thr}; -- {touched} row(s)"
        elif kind.startswith("nullify_"):
            applied = f"UPDATE {tbl} SET {col} = NULL WHERE CAST({col} AS REAL) {op_sym} {thr}; -- {touched} row(s)"
        else:
            applied = f"UPDATE {tbl} SET {col} = {plan.get('replacementValue', thr)!r} WHERE CAST({col} AS REAL) {op_sym} {thr}; -- {touched} row(s)"
        return {
            "appliedSql": applied,
            "message": f"{plan['description']} ({touched} row(s) affected in {table_name}.{column_name}).",
        }

    if kind == "replace_value":
        match_val = str(plan.get("matchValue", ""))
        rep_val = plan.get("replacementValue", "")
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, {col} AS val FROM {tbl};")
        updated = 0
        for r in rows:
            v = r.get("val")
            if v is not None and str(v).strip().lower() == match_val.strip().lower():
                conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (rep_val, r["__rid"]))
                updated += 1
        conn.commit()
        return {
            "appliedSql": f"UPDATE {tbl} SET {col} = {rep_val!r} WHERE LOWER(TRIM({col})) = LOWER({match_val!r}); -- {updated} row(s)",
            "message": f'Replaced "{match_val}" with "{rep_val}" in {updated} row(s) of {table_name}.{column_name}.',
        }

    if kind in ("delete_missing", "fill_missing_value", "impute_missing"):
        table_schema = next((t for t in profile["tables"] if t["name"] == table_name), None)
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, * FROM {tbl};")
        if kind == "delete_missing":
            deleted = 0
            for r in rows:
                if is_missing_value(r.get(column_name)):
                    conn.execute(f"DELETE FROM {tbl} WHERE rowid = ?;", (r["__rid"],))
                    deleted += 1
            conn.commit()
            return {
                "appliedSql": f"DELETE FROM {tbl} WHERE {col} IS NULL OR TRIM(CAST({col} AS TEXT)) = ''; -- {deleted} row(s)",
                "message": f"Deleted {deleted} row(s) with missing {table_name}.{column_name}.",
            }
        if kind == "fill_missing_value":
            rep = plan.get("replacementValue", "")
            updated = 0
            for r in rows:
                if is_missing_value(r.get(column_name)):
                    conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (rep, r["__rid"]))
                    updated += 1
            conn.commit()
            return {
                "appliedSql": f"UPDATE {tbl} SET {col} = {rep!r} WHERE {col} IS NULL OR TRIM(CAST({col} AS TEXT)) = ''; -- {updated} row(s)",
                "message": f"Filled {updated} missing cell(s) in {table_name}.{column_name} with {rep!r}.",
            }
        if table_schema:
            pk_col = next((c["name"] for c in table_schema["columns"] if c["isPrimaryKey"]), None)
            _, imputed_cells = impute_missing_values(table_name, rows, table_schema["columns"], pk_col)
            updated = 0
            for cell in imputed_cells:
                if cell["columnName"] == column_name:
                    rid = rows[cell["rowIndex"]].get("__rid")
                    if rid is not None:
                        conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (cell["guessedValue"], rid))
                        updated += 1
            conn.commit()
            return {
                "appliedSql": f"UPDATE {tbl} SET {col} = PEER_IMPUTED_VALUE WHERE {col} IS NULL; -- {updated} row(s)",
                "message": f"Imputed {updated} missing cell(s) in {table_name}.{column_name} from peer-group statistics.",
            }
        return {"appliedSql": "", "message": f"No missing rows updated in {table_name}.{column_name}."}

    if kind in ("nullify_outliers", "clamp_outliers_iqr", "delete_outliers_iqr"):
        lower, upper, _ = _compute_iqr_bounds()
        _, rows = _query_rows(conn, f"SELECT rowid AS __rid, * FROM {tbl};")
        touched = 0
        for r in rows:
            v = r.get(column_name)
            if is_missing_value(v):
                continue
            try:
                num = float(v)
            except (TypeError, ValueError):
                continue
            if num < lower or num > upper or num < 0:
                if kind == "delete_outliers_iqr":
                    conn.execute(f"DELETE FROM {tbl} WHERE rowid = ?;", (r["__rid"],))
                elif kind == "nullify_outliers":
                    conn.execute(f"UPDATE {tbl} SET {col} = NULL WHERE rowid = ?;", (r["__rid"],))
                else:
                    clamped = round(min(upper, max(lower, num)), 2)
                    conn.execute(f"UPDATE {tbl} SET {col} = ? WHERE rowid = ?;", (clamped, r["__rid"]))
                touched += 1
        conn.commit()
        if kind == "delete_outliers_iqr":
            sql_msg = f"DELETE FROM {tbl} WHERE {col} < {round(lower, 2)} OR {col} > {round(upper, 2)}; -- {touched} row(s)"
        elif kind == "nullify_outliers":
            sql_msg = f"UPDATE {tbl} SET {col} = NULL WHERE {col} < {round(lower, 2)} OR {col} > {round(upper, 2)}; -- {touched} row(s)"
        else:
            sql_msg = f"UPDATE {tbl} SET {col} = CLAMP({col}, {round(lower, 2)}, {round(upper, 2)}); -- {touched} row(s)"
        return {
            "appliedSql": sql_msg,
            "message": f"{plan['description']} ({touched} row(s) updated in {table_name}.{column_name}).",
        }

    raise ValueError(f"Unsupported cleaning plan: {kind}")


def clean_anomaly_in_db(
    db_path: Path,
    anomaly_id: str,
    action_type: str | None = None,
    custom_instruction: str | None = None,
) -> dict[str, str]:
    conn = sqlite3.connect(str(db_path))
    try:
        profile = profile_connection(conn)
        anomaly = next((a for a in profile["anomalies"] if a["id"] == anomaly_id), None)
        if not anomaly:
            raise ValueError(f'Anomaly "{anomaly_id}" not found or already cleared.')

        table_name = anomaly["tableName"]
        column_name = anomaly["columnName"]

        if custom_instruction and custom_instruction.strip():
            conn.close()
            return apply_general_language_cleaning(db_path, table_name, column_name, custom_instruction)

        action = (action_type or anomaly["cleanActionType"]).strip()

        action_map: dict[str, dict[str, Any]] = {
            "normalize_text": {"actionKind": "normalize_title", "description": "Trim spaces and normalize text to Title Case."},
            "normalize_upper": {"actionKind": "normalize_upper", "description": "Trim spaces and convert text to UPPERCASE."},
            "normalize_lower": {"actionKind": "normalize_lower", "description": "Trim spaces and convert text to lowercase."},
            "trim_only": {"actionKind": "trim_whitespace", "description": "Trim leading, trailing, and duplicate spaces."},
            "remove_orphan_fk": {"actionKind": "nullify_orphan_fk", "description": "Set orphan foreign-key references to NULL."},
            "nullify_and_impute": {"actionKind": "nullify_outliers", "description": "Set out-of-range values to NULL for peer-group imputation."},
            "set_null_only": {"actionKind": "nullify_outliers", "description": "Set out-of-range values to NULL."},
            "clamp_outlier": {"actionKind": "clamp_outliers_iqr", "description": "Clamp statistical outliers to IQR fence bounds."},
            "abs_value": {"actionKind": "abs_negative", "description": "Convert negative values to positive (ABS)."},
            "set_zero": {"actionKind": "set_negative_to", "replacementValue": 0, "description": "Replace negative values with 0."},
            "delete_rows": (
                {"actionKind": "delete_orphan_fk", "description": "Delete rows with orphan foreign-key references."}
                if anomaly["kind"] == "orphan_foreign_key"
                else {"actionKind": "delete_outliers_iqr", "description": "Delete anomalous rows from table."}
            ),
        }

        plan = action_map.get(action)
        if not plan:
            raise ValueError(f"Unsupported clean action: {action}")
        return _execute_cleaning_plan_on_conn(conn, profile, table_name, column_name, plan)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def apply_general_language_cleaning(
    db_path: Path,
    table_name: str,
    column_name: str,
    instruction: str,
) -> dict[str, str]:
    clean_inst = (instruction or "").strip()
    if not clean_inst:
        raise ValueError("Please enter a general-language cleaning instruction.")

    conn = sqlite3.connect(str(db_path))
    try:
        profile = profile_connection(conn)
        table_meta = next((t for t in profile["tables"] if t["name"].lower() == table_name.lower()), None)
        if not table_meta:
            raise ValueError(f'Table "{table_name}" does not exist in active database.')
        col_meta = next((c for c in table_meta["columns"] if c["name"].lower() == column_name.lower()), None)
        if not col_meta:
            raise ValueError(f'Column "{column_name}" does not exist in table "{table_meta["name"]}".')

        exact_table = table_meta["name"]
        exact_col = col_meta["name"]

        plan = parse_general_language_cleaning_rule(clean_inst)
        if plan is not None:
            return _execute_cleaning_plan_on_conn(conn, profile, exact_table, exact_col, plan)

        # Optional LLM fallback for complex general-language rules if keys are configured
        from .env_loader import is_llm_configured

        if is_llm_configured():
            from .llm_sql import _call_llm_structured_with_meta, _clean_sql_output

            sample_cols, sample_rows = _query_rows(conn, f"SELECT * FROM {quote_ident(exact_table)} LIMIT 8;")
            system_prompt = (
                "You translate a plain-English data-cleaning rule for ONE SQLite table/column into a single safe "
                "UPDATE or DELETE SQLite statement. Never emit DROP, ALTER, CREATE, ATTACH, PRAGMA, or multiple statements."
            )
            user_prompt = (
                f"Target table: {exact_table}\nTarget column: {exact_col} (type {col_meta['type']})\n"
                f"Columns: {', '.join(sample_cols)}\nSample rows: {sample_rows[:5]}\n\n"
                f"User instruction: {clean_inst}\n"
                'Return JSON with keys: "sql" (single UPDATE or DELETE statement) and "summary" (short description).'
            )
            parsed, llm_meta = _call_llm_structured_with_meta(
                system_prompt,
                user_prompt,
                '{"sql": "string", "summary": "string"}',
            )
            stmt = _clean_sql_output(str(parsed.get("sql") or "")).rstrip(";").strip()
            up = stmt.upper()
            if ";" in stmt:
                raise ValueError("Only a single UPDATE or DELETE statement is allowed.")
            if not (up.startswith(f"UPDATE ") or up.startswith("DELETE ")):
                raise ValueError("General-language rule must translate to an UPDATE or DELETE statement.")
            for forbidden in ("DROP ", "ALTER ", "ATTACH ", "DETACH ", "PRAGMA ", "CREATE ", "VACUUM "):
                if forbidden in up:
                    raise ValueError(f"Disallowed SQL keyword {forbidden.strip()} in rule.")
            cur = conn.execute(stmt)
            conn.commit()
            summary = str(parsed.get("summary") or clean_inst)
            return {
                "appliedSql": f"{stmt}; -- {cur.rowcount} row(s) via Key #{llm_meta['keySlot']}",
                "message": f"{summary} ({cur.rowcount} row(s) updated in {exact_table}.{exact_col}).",
            }

        raise ValueError(
            'Could not parse that general-language instruction deterministically. Try phrases like: '
            '"set negative values to 0", "convert negative to positive", "cap values above 500 to 500", '
            '"replace \'old\' with \'new\'", "trim and title case", "fill missing with 0", or "delete rows with negative values".'
        )
    finally:
        conn.close()


def execute_read_only_sql(
    db_path: str | Path,
    sql: str,
    apply_imputation_overlay: bool = True,
) -> dict[str, Any]:
    trimmed = sql.strip()
    upper = trimmed.upper()
    if not upper.startswith(("SELECT", "WITH", "PRAGMA", "EXPLAIN")):
        return {
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "executionMs": 0.0,
            "error": "Only read-only SELECT, WITH, PRAGMA, or EXPLAIN queries are permitted in query execution.",
        }

    start = time.perf_counter()
    conn = sqlite3.connect(f"file:{Path(db_path)}?mode=ro", uri=True)
    try:
        cols, rows = _query_rows(conn, trimmed)
        elapsed = round((time.perf_counter() - start) * 1000.0, 2)
        result_anomalies: list[str] = []
        if len(rows) > 500:
            result_anomalies.append(
                f"High cardinality result ({len(rows)} rows). Possible missing JOIN predicate or aggregation."
            )

        imputed_markers: dict[str, dict[str, Any]] = {}
        processed_rows = rows
        if apply_imputation_overlay and rows and cols:
            synthetic_cols = [
                {
                    "name": c,
                    "type": "TEXT",
                    "isPrimaryKey": False,
                    "isForeignKey": False,
                    "nullable": True,
                    "missingCount": 0,
                    "missingRate": 0.0,
                    "anomalyCount": 0,
                }
                for c in cols
            ]
            imputed_rows, imputed_cells = impute_missing_values(
                "QueryResult", rows, synthetic_cols
            )
            if imputed_cells:
                processed_rows = imputed_rows
                for meta in imputed_cells:
                    imputed_markers.setdefault(str(meta["rowIndex"]), {})[
                        meta["columnName"]
                    ] = meta
                result_anomalies.append(
                    f"{len(imputed_cells)} missing cell(s) in query output were approximated from peer rows and explicitly marked as GUESSED."
                )

        res: dict[str, Any] = {
            "columns": cols,
            "rows": processed_rows[:200],
            "rowCount": len(processed_rows),
            "executionMs": elapsed,
        }
        if imputed_markers:
            res["imputedCellMarkers"] = imputed_markers
        if result_anomalies:
            res["resultAnomalies"] = result_anomalies
        return res
    except Exception as exc:
        elapsed = round((time.perf_counter() - start) * 1000.0, 2)
        return {
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "executionMs": elapsed,
            "error": str(exc),
        }
    finally:
        conn.close()
