from __future__ import annotations

import math
import statistics
from typing import Any

MISSING_SENTINELS = {
    "",
    "na",
    "n/a",
    "null",
    "none",
    "nan",
    "unknown",
    "-",
    "?",
}


def is_missing_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return math.isnan(value)
    if isinstance(value, str):
        return value.strip().lower() in MISSING_SENTINELS
    return False


def _to_float(value: Any) -> float | None:
    if isinstance(value, bool) or is_missing_value(value):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    try:
        f = float(str(value).strip())
        return f if math.isfinite(f) else None
    except (ValueError, TypeError):
        return None


def _round2(n: float) -> float:
    return round(n * 100.0) / 100.0


def detect_numeric_outliers(
    rows: list[dict[str, Any]],
    table_name: str,
    column_name: str,
) -> dict[str, Any] | None:
    numeric_entries: list[tuple[int, float]] = []
    for idx, row in enumerate(rows):
        num = _to_float(row.get(column_name))
        if num is not None:
            numeric_entries.append((idx, num))

    lower_name = column_name.lower()
    must_be_non_negative = any(
        kw in lower_name
        for kw in (
            "age",
            "salary",
            "price",
            "amount",
            "total",
            "cost",
            "qty",
            "quantity",
            "hours",
            "score",
            "revenue",
            "count",
            "weight",
            "height",
            "budget",
        )
    )

    if len(numeric_entries) < 5 and not (must_be_non_negative and any(v < 0 for _, v in numeric_entries)):
        return None

    sorted_vals = sorted(v for _, v in numeric_entries)
    q1 = sorted_vals[int(len(sorted_vals) * 0.25)]
    q3 = sorted_vals[int(len(sorted_vals) * 0.75)]
    iqr = q3 - q1
    lower_fence = q1 - 1.5 * iqr
    upper_fence = q3 + 1.5 * iqr

    outliers: list[tuple[int, float]] = []
    for idx, val in numeric_entries:
        if must_be_non_negative and val < 0:
            outliers.append((idx, val))
        elif len(numeric_entries) >= 5:
            if iqr == 0:
                med = sorted_vals[len(sorted_vals) // 2]
                if med != 0 and abs(val - med) > abs(med) * 4:
                    outliers.append((idx, val))
            elif val < lower_fence or val > upper_fence:
                outliers.append((idx, val))

    if not outliers:
        return None

    has_negative = must_be_non_negative and any(v < 0 for _, v in outliers)
    if has_negative:
        cleaning_options = [
            {
                "id": "nullify_and_impute",
                "label": "Nullify & Re-Impute",
                "description": "Set invalid negative/outlier entries to NULL and mark for peer-group imputation.",
                "recommended": True,
            },
            {
                "id": "abs_value",
                "label": "Convert Negative to Positive",
                "description": "Flip negative values using ABS(value) so magnitude is kept positive.",
            },
            {
                "id": "set_zero",
                "label": "Replace Negative with 0",
                "description": "Set all negative entries in this column to 0.",
            },
            {
                "id": "delete_rows",
                "label": "Delete Affected Rows",
                "description": "Remove rows containing invalid negative or extreme values.",
            },
        ]
    else:
        cleaning_options = [
            {
                "id": "clamp_outlier",
                "label": "Clamp to IQR Fence",
                "description": f"Clamp values outside [{_round2(max(0.0, lower_fence))}, {_round2(upper_fence)}] to fence bounds.",
                "recommended": True,
            },
            {
                "id": "nullify_and_impute",
                "label": "Nullify Outliers",
                "description": "Set out-of-range outliers to NULL so peer imputation can estimate them.",
            },
            {
                "id": "delete_rows",
                "label": "Delete Outlier Rows",
                "description": "Remove rows whose value lies outside the IQR statistical fence.",
            },
        ]

    return {
        "id": f"outlier_{table_name}_{column_name}",
        "kind": "negative_domain_violation" if has_negative else "numeric_outlier",
        "severity": "high" if (has_negative or len(outliers) >= 2) else "medium",
        "tableName": table_name,
        "columnName": column_name,
        "affectedRowCount": len(outliers),
        "sampleValues": [str(v) for _, v in outliers[:4]],
        "description": (
            f"{len(outliers)} row(s) in {table_name}.{column_name} contain negative or extreme domain-violating values (IQR fence [{_round2(lower_fence)}, {_round2(upper_fence)}])."
            if has_negative
            else f"{len(outliers)} statistical outlier(s) detected in {table_name}.{column_name} outside IQR fence [{_round2(lower_fence)}, {_round2(upper_fence)}]."
        ),
        "recommendedAction": (
            "Nullify invalid negative/extreme entries and impute using peer group median."
            if has_negative
            else "Clamp extreme values to IQR fence bounds or nullify and re-impute."
        ),
        "cleanActionType": "nullify_and_impute" if has_negative else "clamp_outlier",
        "cleaningOptions": cleaning_options,
        "cleared": False,
    }


def detect_casing_and_whitespace_anomalies(
    rows: list[dict[str, Any]],
    table_name: str,
    column_name: str,
) -> dict[str, Any] | None:
    variants_by_canonical: dict[str, set[str]] = {}
    affected = 0
    samples: list[str] = []
    seen_samples: set[str] = set()

    for row in rows:
        raw = row.get(column_name)
        if not isinstance(raw, str) or is_missing_value(raw):
            continue
        canonical = " ".join(raw.strip().split()).lower()
        variants_by_canonical.setdefault(canonical, set()).add(raw)
        if raw != raw.strip():
            affected += 1
            rep = repr(raw)
            if rep not in seen_samples:
                seen_samples.add(rep)
                samples.append(rep)

    for variants in variants_by_canonical.values():
        if len(variants) > 1:
            affected += len(variants)
            for v in variants:
                if v not in seen_samples:
                    seen_samples.add(v)
                    samples.append(v)

    if affected == 0:
        return None

    return {
        "id": f"casing_{table_name}_{column_name}",
        "kind": "casing_fragmentation",
        "severity": "medium",
        "tableName": table_name,
        "columnName": column_name,
        "affectedRowCount": affected,
        "sampleValues": samples[:4],
        "description": f"Inconsistent casing or trailing whitespace in {table_name}.{column_name} splits identical categories during GROUP BY / WHERE filters.",
        "recommendedAction": "Trim whitespace and normalize to canonical Title Case.",
        "cleanActionType": "normalize_text",
        "cleaningOptions": [
            {
                "id": "normalize_text",
                "label": "Trim & Title Case",
                "description": "Trim extra spaces and convert values to canonical Title Case.",
                "recommended": True,
            },
            {
                "id": "normalize_upper",
                "label": "Trim & UPPERCASE",
                "description": "Trim extra spaces and convert all values to UPPERCASE.",
            },
            {
                "id": "normalize_lower",
                "label": "Trim & lowercase",
                "description": "Trim extra spaces and convert all values to lowercase.",
            },
            {
                "id": "trim_only",
                "label": "Trim Whitespace Only",
                "description": "Remove leading, trailing, and repeated spaces while keeping existing case.",
            },
        ],
        "cleared": False,
    }


def parse_general_language_cleaning_rule(instruction: str) -> dict[str, Any] | None:
    import re

    raw = (instruction or "").strip()
    if not raw:
        return None
    low = re.sub(r"\s+", " ", raw.lower())

    is_delete = bool(
        re.search(r"\b(delete|remove|drop|purge)\b", low)
        and re.search(
            r"\brow(s)?\b|\borphan\b|\bnegative\b|\boutlier|\bmissing\b|\bnull\b|\bempty\b|\babove\b|\bover\b|\bbelow\b|\bunder\b|\bgreater\b|\bless\b",
            low,
        )
    )

    if re.search(r"\borphan", low):
        if re.search(r"\b(delete|remove|drop)\b", low) and not re.search(r"\bnull", low):
            return {
                "actionKind": "delete_orphan_fk",
                "description": "Delete rows with orphan foreign-key references.",
            }
        return {
            "actionKind": "nullify_orphan_fk",
            "description": "Set orphan foreign-key references to NULL.",
        }

    rep_quoted = re.search(
        r"(?:replace|change|convert|map|set)\s+['\"`]([^'\"`]+)['\"`]\s+(?:with|to|into|as)\s+['\"`]([^'\"`]*)['\"`]",
        raw,
        re.IGNORECASE,
    )
    if rep_quoted:
        from_val, to_val = rep_quoted.group(1), rep_quoted.group(2)
        return {
            "actionKind": "replace_value",
            "matchValue": from_val,
            "replacementValue": to_val,
            "description": f'Replace "{from_val}" with "{to_val}".',
        }

    if re.search(r"\bnegative(s)?\b|<\s*0\b|\bbelow zero\b|\bless than zero\b", low):
        if re.search(r"\b(abs|absolute|positive|flip sign)\b", low):
            return {
                "actionKind": "abs_negative",
                "description": "Convert negative numbers to positive values (ABS).",
            }
        if re.search(r"\b(delete|remove|drop)\b", low) and re.search(r"\brow", low):
            return {
                "actionKind": "delete_negative",
                "description": "Delete rows containing negative values.",
            }
        if re.search(r"\bnull(ify)?\b", low) and not re.search(r"\bimpute|guess|fill\b", low):
            return {
                "actionKind": "nullify_negative",
                "description": "Set negative values to NULL.",
            }
        num_match = re.search(r"(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?)", low)
        if num_match:
            val = float(num_match.group(1))
            val_clean: int | float = int(val) if val.is_integer() else val
            return {
                "actionKind": "set_negative_to",
                "replacementValue": val_clean,
                "description": f"Replace negative values with {val_clean}.",
            }
        if re.search(r"\b(delete|remove|drop)\b", low):
            return {
                "actionKind": "delete_negative",
                "description": "Delete rows containing negative values.",
            }
        if re.search(r"\bimpute|guess|median|mean|average\b", low):
            return {
                "actionKind": "nullify_outliers",
                "description": "Nullify negative values and re-impute from peers.",
            }
        return {
            "actionKind": "set_negative_to",
            "replacementValue": 0,
            "description": "Replace negative values with 0.",
        }

    cap_match = re.search(r"\b(?:cap|clamp max|max)\b.*?\b(?:at|to)\s*(-?\d+(?:\.\d+)?)", low)
    if cap_match:
        thr = float(cap_match.group(1))
        thr_c = int(thr) if thr.is_integer() else thr
        return {
            "actionKind": "cap_above",
            "threshold": thr_c,
            "replacementValue": thr_c,
            "description": f"Cap values above {thr_c} to {thr_c}.",
        }

    above_match = re.search(
        r"(?:above|over|greater than|more than|exceeding|exceeds|>|>=)\s*(-?\d+(?:\.\d+)?)(?:.*?(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?|null))?",
        low,
    )
    if above_match:
        thr = float(above_match.group(1))
        thr_c = int(thr) if thr.is_integer() else thr
        tgt_raw = above_match.group(2)
        if re.search(r"\b(delete|remove|drop)\b", low):
            return {
                "actionKind": "delete_above",
                "threshold": thr_c,
                "description": f"Delete rows where value > {thr_c}.",
            }
        if tgt_raw == "null" or re.search(r"\bnull(ify)?\b", low):
            return {
                "actionKind": "nullify_above",
                "threshold": thr_c,
                "description": f"Set values > {thr_c} to NULL.",
            }
        tgt = float(tgt_raw) if tgt_raw is not None else thr
        tgt_c = int(tgt) if tgt.is_integer() else tgt
        return {
            "actionKind": "cap_above",
            "threshold": thr_c,
            "replacementValue": tgt_c,
            "description": f"Set values > {thr_c} to {tgt_c}.",
        }

    floor_match = re.search(r"\b(?:floor|clamp min|min)\b.*?\b(?:at|to)\s*(-?\d+(?:\.\d+)?)", low)
    if floor_match:
        thr = float(floor_match.group(1))
        thr_c = int(thr) if thr.is_integer() else thr
        return {
            "actionKind": "floor_below",
            "threshold": thr_c,
            "replacementValue": thr_c,
            "description": f"Raise values below {thr_c} to {thr_c}.",
        }

    below_match = re.search(
        r"(?:below|under|less than|smaller than|<|<=)\s*(-?\d+(?:\.\d+)?)(?:.*?(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?|null))?",
        low,
    )
    if below_match:
        thr = float(below_match.group(1))
        thr_c = int(thr) if thr.is_integer() else thr
        tgt_raw = below_match.group(2)
        if re.search(r"\b(delete|remove|drop)\b", low):
            return {
                "actionKind": "delete_below",
                "threshold": thr_c,
                "description": f"Delete rows where value < {thr_c}.",
            }
        if tgt_raw == "null" or re.search(r"\bnull(ify)?\b", low):
            return {
                "actionKind": "nullify_below",
                "threshold": thr_c,
                "description": f"Set values < {thr_c} to NULL.",
            }
        tgt = float(tgt_raw) if tgt_raw is not None else thr
        tgt_c = int(tgt) if tgt.is_integer() else tgt
        return {
            "actionKind": "floor_below",
            "threshold": thr_c,
            "replacementValue": tgt_c,
            "description": f"Set values < {thr_c} to {tgt_c}.",
        }

    if re.search(r"\boutlier", low):
        if is_delete or re.search(r"\b(delete|remove|drop)\b", low):
            return {
                "actionKind": "delete_outliers_iqr",
                "description": "Delete statistical outlier rows outside IQR bounds.",
            }
        if re.search(r"\bnull(ify)?\b", low):
            return {
                "actionKind": "nullify_outliers",
                "description": "Set IQR statistical outliers to NULL.",
            }
        return {
            "actionKind": "clamp_outliers_iqr",
            "description": "Clamp statistical outliers to IQR fence bounds.",
        }

    if re.search(r"\b(missing|null|empty|blank|na|n/a)\b", low):
        if re.search(r"\b(delete|remove|drop)\b", low):
            return {
                "actionKind": "delete_missing",
                "description": "Delete rows with missing or NULL values in this column.",
            }
        if re.search(r"\b(impute|guess|peer|median|mean|average|mode)\b", low):
            return {
                "actionKind": "impute_missing",
                "description": "Impute missing cells using peer-group average/mode.",
            }
        fill_match = re.search(r"(?:with|to|as|=)\s*['\"`]?([^'\"`]+?)['\"`]?$", raw, re.IGNORECASE)
        if fill_match:
            val_str = fill_match.group(1).strip()
            val_out: str | int | float = val_str
            if re.fullmatch(r"-?\d+(?:\.\d+)?", val_str):
                f = float(val_str)
                val_out = int(f) if f.is_integer() else f
            return {
                "actionKind": "fill_missing_value",
                "replacementValue": val_out,
                "description": f"Fill missing/NULL cells with {val_out}.",
            }

    if re.search(r"\b(upper\s*case|uppercase|all\s*caps|capital letters)\b", low):
        return {
            "actionKind": "normalize_upper",
            "description": "Trim spaces and convert text to UPPERCASE.",
        }
    if re.search(r"\b(lower\s*case|lowercase)\b", low):
        return {
            "actionKind": "normalize_lower",
            "description": "Trim spaces and convert text to lowercase.",
        }
    if re.search(r"\b(title\s*case|titlecase|normalize|capitalize|consistent casing)\b", low):
        return {
            "actionKind": "normalize_title",
            "description": "Trim spaces and normalize text to Title Case.",
        }
    if re.search(r"\b(trim|whitespace|extra spaces|leading spaces|trailing spaces)\b", low):
        return {
            "actionKind": "trim_whitespace",
            "description": "Trim leading, trailing, and duplicate spaces.",
        }

    return None


def _mode_of_strings(values: list[str]) -> str:
    counts: dict[str, int] = {}
    best = values[0] if values else "Unknown"
    best_count = 0
    for v in values:
        counts[v] = counts.get(v, 0) + 1
        if counts[v] > best_count:
            best_count = counts[v]
            best = v
    return best


def impute_missing_values(
    table_name: str,
    rows: list[dict[str, Any]],
    columns: list[dict[str, Any]],
    pk_col: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    imputed_rows = [dict(r) for r in rows]
    imputed_cells: list[dict[str, Any]] = []

    if not rows:
        return imputed_rows, imputed_cells

    group_candidates: list[dict[str, Any]] = []
    for c in columns:
        if c.get("isPrimaryKey"):
            continue
        distinct = {
            str(r.get(c["name"]))
            for r in rows
            if not is_missing_value(r.get(c["name"]))
        }
        if 2 <= len(distinct) <= max(8, int(len(rows) * 0.6)):
            group_candidates.append(c)

    for col in columns:
        if col.get("isPrimaryKey"):
            continue
        col_name = col["name"]
        non_missing = [r.get(col_name) for r in rows if not is_missing_value(r.get(col_name))]
        if not non_missing:
            continue

        numeric_vals = [n for n in (_to_float(v) for v in non_missing) if n is not None]
        is_numeric = len(numeric_vals) >= math.ceil(len(non_missing) * 0.7)

        best_group_col = None
        for g in group_candidates:
            if g["name"] != col_name:
                best_group_col = g["name"]
                break

        for row_idx, row in enumerate(rows):
            original_val = row.get(col_name)
            if not is_missing_value(original_val):
                continue

            if is_numeric:
                group_key = row.get(best_group_col) if best_group_col else None
                peer_nums: list[float] = []
                if best_group_col and not is_missing_value(group_key):
                    for peer in rows:
                        if (
                            str(peer.get(best_group_col)).lower() == str(group_key).lower()
                            and not is_missing_value(peer.get(col_name))
                        ):
                            num = _to_float(peer.get(col_name))
                            if num is not None:
                                peer_nums.append(num)

                if len(peer_nums) >= 2:
                    guessed_val: Any = _round2(sum(peer_nums) / len(peer_nums))
                    method = "Conditional Peer-Group Mean"
                    basis = [best_group_col]
                    confidence = min(0.92, 0.68 + len(peer_nums) * 0.04)
                    explanation = f'Guessed from {len(peer_nums)} peer rows sharing {best_group_col} = "{group_key}".'
                else:
                    guessed_val = _round2(statistics.median(numeric_vals))
                    method = "Column Median Fallback"
                    basis = [col_name]
                    confidence = 0.56
                    explanation = f"Guessed using median of {len(numeric_vals)} observed {col_name} values."
            else:
                group_key = row.get(best_group_col) if best_group_col else None
                peer_strs: list[str] = []
                if best_group_col and not is_missing_value(group_key):
                    for peer in rows:
                        if (
                            str(peer.get(best_group_col)).lower() == str(group_key).lower()
                            and not is_missing_value(peer.get(col_name))
                        ):
                            peer_strs.append(str(peer.get(col_name)))

                if peer_strs:
                    guessed_val = _mode_of_strings(peer_strs)
                    method = "Conditional Group Mode"
                    basis = [best_group_col]
                    confidence = min(0.89, 0.65 + len(peer_strs) * 0.05)
                    explanation = f'Guessed as most frequent {col_name} among rows with {best_group_col} = "{group_key}".'
                else:
                    guessed_val = _mode_of_strings([str(v) for v in non_missing])
                    method = "Global Column Mode"
                    basis = [col_name]
                    confidence = 0.52
                    explanation = f"Guessed using global mode across {len(non_missing)} observed rows."

            imputed_rows[row_idx][col_name] = guessed_val
            row_id_val = row.get(pk_col) if pk_col else (row_idx + 1)
            imputed_cells.append(
                {
                    "rowIndex": row_idx,
                    "rowId": row_id_val if row_id_val is not None else (row_idx + 1),
                    "tableName": table_name,
                    "columnName": col_name,
                    "originalValue": original_val,
                    "guessedValue": guessed_val,
                    "method": method,
                    "basisColumns": basis,
                    "confidence": round(confidence, 2),
                    "explanation": explanation,
                }
            )

    return imputed_rows, imputed_cells
