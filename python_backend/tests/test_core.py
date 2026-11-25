import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from python_backend.data_quality import (
    detect_casing_and_whitespace_anomalies,
    detect_numeric_outliers,
    impute_missing_values,
)
from python_backend.db_manager import (
    DbManager,
    clean_anomaly_in_db,
    execute_read_only_sql,
    profile_sqlite_file,
)
from python_backend.env_loader import get_llm_config, is_llm_configured
from python_backend.graph_engine import enumerate_join_paths, parse_sql_to_query_graph
from python_backend.spider_benchmark import (
    compare_execution_results,
    compute_component_match_f1,
    get_spider_dataset_info,
    load_official_spider_tasks,
)


class GraphSqlPythonTests(unittest.TestCase):
    def test_graph_edge_matching_avoids_unused_legacy_edge(self) -> None:
        tables = [
            {
                "name": "Customers",
                "rowCount": 4,
                "columns": [
                    {"name": "customer_id", "isPrimaryKey": True},
                    {"name": "customer_name", "isPrimaryKey": False},
                ],
            },
            {
                "name": "Invoices",
                "rowCount": 4,
                "columns": [
                    {"name": "invoice_id", "isPrimaryKey": True},
                    {"name": "customer_id", "isPrimaryKey": False},
                ],
            },
            {
                "name": "Orders",
                "rowCount": 4,
                "columns": [
                    {"name": "order_id", "isPrimaryKey": True},
                    {"name": "invoice_id", "isPrimaryKey": False},
                    {"name": "legacy_customer_id", "isPrimaryKey": False},
                ],
            },
        ]
        edges = [
            {
                "id": "e_ord_inv",
                "fromTable": "Orders",
                "fromColumn": "invoice_id",
                "toTable": "Invoices",
                "toColumn": "invoice_id",
                "inferred": False,
                "orphanCount": 0,
                "missingRate": 0.0,
                "anomalyPenalty": 0.0,
            },
            {
                "id": "e_inv_cust",
                "fromTable": "Invoices",
                "fromColumn": "customer_id",
                "toTable": "Customers",
                "toColumn": "customer_id",
                "inferred": False,
                "orphanCount": 0,
                "missingRate": 0.0,
                "anomalyPenalty": 0.0,
            },
            {
                "id": "e_ord_legacy",
                "fromTable": "Orders",
                "fromColumn": "legacy_customer_id",
                "toTable": "Customers",
                "toColumn": "customer_id",
                "inferred": False,
                "orphanCount": 2,
                "missingRate": 0.25,
                "anomalyPenalty": 0.825,
            },
        ]
        sql = (
            "SELECT c.customer_name, COUNT(o.order_id) "
            "FROM Orders o JOIN Invoices i ON o.invoice_id = i.invoice_id "
            "JOIN Customers c ON i.customer_id = c.customer_id "
            "GROUP BY c.customer_name;"
        )
        plan = parse_sql_to_query_graph(sql, tables, edges)
        self.assertIn("e_ord_inv", plan["usedEdgeIds"])
        self.assertIn("e_inv_cust", plan["usedEdgeIds"])
        self.assertNotIn("e_ord_legacy", plan["usedEdgeIds"])

        paths = enumerate_join_paths(tables, edges, "Orders", "Customers", 4)
        self.assertEqual(len(paths), 2)
        self.assertGreater(paths[0]["resilienceScore"], paths[1]["resilienceScore"])

    def test_imputation_and_anomaly_detection(self) -> None:
        rows = [
            {"id": 1, "dept": "Engineering", "salary": 140000},
            {"id": 2, "dept": "Engineering", "salary": 144000},
            {"id": 3, "dept": "Engineering", "salary": None},
            {"id": 4, "dept": "Design", "salary": -35000},
            {"id": 5, "dept": "Design ", "salary": 110000},
        ]
        cols = [
            {"name": "id", "isPrimaryKey": True},
            {"name": "dept", "isPrimaryKey": False},
            {"name": "salary", "isPrimaryKey": False},
        ]
        imputed_rows, cells = impute_missing_values("Employees", rows, cols, "id")
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]["guessedValue"], 142000.0)
        self.assertEqual(imputed_rows[2]["salary"], 142000.0)

        outlier = detect_numeric_outliers(rows, "Employees", "salary")
        self.assertIsNotNone(outlier)
        self.assertEqual(outlier["kind"], "negative_domain_violation")

        casing = detect_casing_and_whitespace_anomalies(rows, "Employees", "dept")
        self.assertIsNotNone(casing)
        self.assertEqual(casing["kind"], "casing_fragmentation")

    def test_db_manager_sql_and_binary_upload_and_clean(self) -> None:
        mgr = DbManager()
        sess = mgr.load_example("unit_test_sess", "ecommerce_multipath")
        self.assertIsNotNone(sess.db_path)
        profile = profile_sqlite_file(sess.db_path)
        self.assertGreaterEqual(len(profile["tables"]), 6)
        self.assertGreater(profile["totalAnomalies"], 0)

        # Clean one anomaly and verify reduction
        first_anom = profile["anomalies"][0]["id"]
        clean_anomaly_in_db(sess.db_path, first_anom)
        after = profile_sqlite_file(sess.db_path)
        self.assertLess(after["totalAnomalies"], profile["totalAnomalies"])

        # Reset restores initial anomaly count
        mgr.reset_session("unit_test_sess")
        restored = profile_sqlite_file(sess.db_path)
        self.assertEqual(restored["totalAnomalies"], profile["totalAnomalies"])

        # Test binary .db file load
        with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
            conn = sqlite3.connect(tmp.name)
            conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, price REAL);")
            conn.execute("INSERT INTO items VALUES (1, 12.5), (2, NULL);")
            conn.commit()
            conn.close()
            raw_bytes = Path(tmp.name).read_bytes()
            up_sess = mgr.load_uploaded_file("unit_test_upload", "sample.db", raw_bytes)
            res = execute_read_only_sql(up_sess.db_path, "SELECT * FROM items;")
            self.assertIsNone(res.get("error"))
            self.assertEqual(res["rowCount"], 2)
            self.assertIn("imputedCellMarkers", res)

    def test_official_spider_dataset_and_comparator(self) -> None:
        info = get_spider_dataset_info()
        self.assertTrue(info["downloaded"])
        self.assertEqual(info["totalTasks"], 1034)
        self.assertGreaterEqual(info["totalDatabases"], 20)

        tasks, _ = load_official_spider_tasks()
        first = tasks[0]
        gold_exec = execute_read_only_sql(
            first["dbPath"], first["goldSql"], apply_imputation_overlay=False
        )
        self.assertIsNone(gold_exec.get("error"))
        self.assertTrue(compare_execution_results(gold_exec, gold_exec, order_sensitive=False))
        self.assertEqual(compute_component_match_f1(first["goldSql"], first["goldSql"]), 1.0)

    def test_env_key_resolution_reads_dotenv_open_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text(
                'LLM_API_KEY=""\nLLM_BASE_URL=""\nLLM_MODEL=""\nLLM_TIMEOUT_SEC=""\n',
                encoding="utf-8",
            )
            self.assertFalse(is_llm_configured(env_file))
            with self.assertRaises(RuntimeError):
                get_llm_config(env_file)

            # Missing base URL specifically must also fail cleanly
            env_file.write_text(
                'LLM_API_KEY="sk-user-filled-key"\nLLM_BASE_URL=""\nLLM_MODEL="llama-3.3-70b-versatile"\n',
                encoding="utf-8",
            )
            self.assertFalse(is_llm_configured(env_file))

            env_file.write_text(
                'LLM_API_KEY="sk-user-filled-key"\n'
                'LLM_BASE_URL="https://api.groq.com/openai/v1/"\n'
                'LLM_MODEL="llama-3.3-70b-versatile"\n'
                'LLM_TIMEOUT_SEC=""\n',
                encoding="utf-8",
            )
            cfg = get_llm_config(env_file)
            self.assertEqual(cfg.api_key, "sk-user-filled-key")
            self.assertEqual(cfg.base_url, "https://api.groq.com/openai/v1")
            self.assertEqual(cfg.model, "llama-3.3-70b-versatile")
            self.assertEqual(cfg.timeout_sec, 60)
            self.assertTrue(is_llm_configured(env_file))

    def test_llm_request_includes_custom_user_agent(self) -> None:
        import json
        from unittest.mock import patch
        from python_backend.env_loader import LlmConfig
        from python_backend.llm_sql import _call_llm_structured

        captured_headers: dict[str, str] = {}

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self) -> bytes:
                return json.dumps(
                    {"choices": [{"message": {"content": json.dumps({"ok": True})}}]}
                ).encode("utf-8")

        def fake_urlopen(req, timeout=60):
            captured_headers.update({k.lower(): v for k, v in req.header_items()})
            return FakeResp()

        fake_cfg = LlmConfig(
            api_key="test-key",
            base_url="https://api.groq.com/openai/v1",
            model="openai/gpt-oss-120b",
            timeout_sec=30,
        )
        with (
            patch("python_backend.llm_sql.get_llm_configs", return_value=[fake_cfg]),
            patch("urllib.request.urlopen", side_effect=fake_urlopen),
        ):
            res = _call_llm_structured("sys", "usr", "{}")

        self.assertTrue(res.get("ok"))
        self.assertIn("user-agent", captured_headers)
        self.assertNotIn("python-urllib", captured_headers["user-agent"].lower())
        self.assertEqual(captured_headers.get("accept"), "application/json")

    def test_three_api_key_resolution_and_failover(self) -> None:
        import io
        import json
        import urllib.error
        from unittest.mock import patch
        from python_backend.env_loader import get_llm_configs
        from python_backend.llm_sql import _KEY_COOLDOWNS, _call_llm_structured_with_meta

        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text(
                'LLM_API_KEY="gsk_key_one_1111"\n'
                'LLM_API_KEY_2="gsk_key_two_2222"\n'
                'LLM_API_KEY_3="gsk_key_three_3333"\n'
                'LLM_BASE_URL="https://api.groq.com/openai/v1"\n'
                'LLM_MODEL="openai/gpt-oss-120b"\n',
                encoding="utf-8",
            )
            configs = get_llm_configs(env_file)
            self.assertEqual(len(configs), 3)
            self.assertEqual([c.slot for c in configs], [1, 2, 3])
            self.assertEqual([c.api_key for c in configs], [
                "gsk_key_one_1111",
                "gsk_key_two_2222",
                "gsk_key_three_3333",
            ])

            _KEY_COOLDOWNS.clear()
            tried_auths: list[str] = []

            class FakeSuccess:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def read(self) -> bytes:
                    return json.dumps(
                        {"choices": [{"message": {"content": json.dumps({"winner": "key3"})}}]}
                    ).encode("utf-8")

            def fake_urlopen(req, timeout=60):
                auth = dict(req.header_items()).get("Authorization", "")
                tried_auths.append(auth)
                if "gsk_key_one_1111" in auth:
                    raise urllib.error.HTTPError(
                        req.full_url,
                        429,
                        "Too Many Requests",
                        {},
                        io.BytesIO(b'{"error":{"message":"Token limit reached (TPM)"}}'),
                    )
                if "gsk_key_two_2222" in auth:
                    raise urllib.error.HTTPError(
                        req.full_url,
                        403,
                        "Forbidden",
                        {},
                        io.BytesIO(b'{"error":{"message":"Quota exhausted"}}'),
                    )
                return FakeSuccess()

            with (
                patch("python_backend.llm_sql.get_llm_configs", return_value=configs),
                patch("urllib.request.urlopen", side_effect=fake_urlopen),
            ):
                parsed, meta = _call_llm_structured_with_meta("sys", "usr", "{}")

            self.assertEqual(parsed.get("winner"), "key3")
            self.assertEqual(tried_auths, [
                "Bearer gsk_key_one_1111",
                "Bearer gsk_key_two_2222",
                "Bearer gsk_key_three_3333",
            ])
            self.assertEqual(meta["keySlot"], 3)
            self.assertEqual(meta["totalKeysConfigured"], 3)
            self.assertEqual(len(meta["failovers"]), 2)

    def test_query_cost_comparison_selects_lowest_cost_clean_path(self) -> None:
        from unittest.mock import patch
        from python_backend.llm_sql import generate_and_run_text_to_sql

        mgr = DbManager()
        sess = mgr.load_example("cost_test_sess", "ecommerce_multipath")
        fake_llm_output = {
            "explanation": "Evaluated corrupted shortcut vs clean invoice join.",
            "candidates": [
                {
                    "label": "Corrupted Legacy Shortcut",
                    "strategy": "Direct Legacy FK",
                    "sql": (
                        "SELECT c.customer_name, SUM(o.total_amount) AS total_amt "
                        "FROM Orders o JOIN Customers c ON o.legacy_customer_id = c.customer_id "
                        "GROUP BY c.customer_name ORDER BY total_amt DESC;"
                    ),
                    "graphPathTables": ["Orders", "Customers"],
                    "semanticScore": 0.9,
                    "rationale": "Uses shortcut FK directly.",
                },
                {
                    "label": "Verified Invoice Path",
                    "strategy": "Clean Normalized Join",
                    "sql": (
                        "SELECT c.customer_name, SUM(o.total_amount) AS total_amt "
                        "FROM Orders o JOIN Invoices i ON o.invoice_id = i.invoice_id "
                        "JOIN Customers c ON i.customer_id = c.customer_id "
                        "GROUP BY c.customer_name;"
                    ),
                    "graphPathTables": ["Orders", "Invoices", "Customers"],
                    "semanticScore": 0.95,
                    "rationale": "Avoids orphan legacy edge.",
                },
            ],
        }
        fake_meta = {
            "keySlot": 2,
            "maskedKey": "gsk_...2222",
            "model": "openai/gpt-oss-120b",
            "totalKeysConfigured": 3,
            "failovers": ["Key #1 hit HTTP 429 -> switched to Key #2"],
        }

        with patch(
            "python_backend.llm_sql._call_llm_structured_with_meta",
            return_value=(fake_llm_output, fake_meta),
        ):
            res = generate_and_run_text_to_sql(
                "Show total verified order amount per customer",
                sess.db_path,
                max_candidates=2,
            )

        cands = res["candidates"]
        self.assertEqual(len(cands), 2)
        self.assertTrue(cands[0]["selected"])
        self.assertEqual(cands[0]["label"], "Verified Invoice Path")
        self.assertLess(cands[0]["queryCost"], cands[1]["queryCost"])
        self.assertTrue(cands[0]["costBreakdown"]["planSteps"])
        self.assertEqual(res["llmMeta"]["keySlot"], 2)
        self.assertIn("Higher", cands[1]["selectionReason"])

    def test_manual_anomaly_options_and_general_language_cleaning(self) -> None:
        from python_backend.db_manager import (
            apply_general_language_cleaning,
            clean_anomaly_in_db,
            profile_sqlite_file,
        )

        mgr = DbManager()
        sess = mgr.load_example("manual_clean_sess", "ecommerce_multipath")
        assert sess.db_path is not None

        profile = profile_sqlite_file(sess.db_path)
        self.assertTrue(len(profile["anomalies"]) >= 2)
        for anom in profile["anomalies"]:
            self.assertTrue(len(anom.get("cleaningOptions") or []) >= 2)

        # Manual option on casing fragmentation -> UPPERCASE
        casing_anom = next(a for a in profile["anomalies"] if a["kind"] == "casing_fragmentation")
        res_upper = clean_anomaly_in_db(sess.db_path, casing_anom["id"], action_type="normalize_upper")
        self.assertIn("UPPERCASE", res_upper["message"])

        # General-language rule on negative / numeric values
        num_anom = next(
            (a for a in profile["anomalies"] if a["kind"] in ("negative_domain_violation", "numeric_outlier")),
            None,
        )
        if num_anom:
            res_gl = clean_anomaly_in_db(
                sess.db_path,
                num_anom["id"],
                custom_instruction="set negative values to 0",
            )
            self.assertIn("0", res_gl["message"])

        # Arbitrary column rule via general language
        res_custom = apply_general_language_cleaning(
            sess.db_path,
            "Customers",
            "region",
            "trim spaces and convert to title case",
        )
        self.assertIn("Customers.region", res_custom["message"])


if __name__ == "__main__":
    unittest.main()
