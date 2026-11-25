from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _resolve_env_path(env_path: str | Path | None = None) -> Path:
    if env_path is not None:
        return Path(env_path)
    cwd_env = Path(".env")
    if cwd_env.exists():
        return cwd_env
    return PROJECT_ROOT / ".env"


def _read_dotenv_dict(env_path: str | Path | None = None) -> dict[str, str]:
    path = _resolve_env_path(env_path)
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_dotenv_file(env_path: str | Path | None = None) -> None:
    """Load values from .env into os.environ (non-empty .env values update dynamically)."""
    parsed = _read_dotenv_dict(env_path)
    for key, value in parsed.items():
        if value:
            os.environ[key] = value


def mask_api_key(api_key: str) -> str:
    clean = api_key.strip()
    if len(clean) <= 8:
        return "***"
    return f"{clean[:4]}...{clean[-4:]}"


@dataclass
class LlmConfig:
    api_key: str
    base_url: str
    model: str
    timeout_sec: int = 60
    slot: int = 1
    masked_key: str = ""

    def __post_init__(self) -> None:
        if not self.masked_key:
            self.masked_key = mask_api_key(self.api_key)


def _first_non_empty(dotenv_map: dict[str, str], keys: tuple[str, ...]) -> str:
    for k in keys:
        val = (dotenv_map.get(k) or os.environ.get(k) or "").strip()
        if val:
            return val
    return ""


def get_llm_configs(env_path: str | Path | None = None) -> list[LlmConfig]:
    """Resolve up to 3 API key failover slots plus shared/per-slot URL, model, and timeout."""
    dotenv_map = _read_dotenv_dict(env_path)

    shared_base_url = _first_non_empty(
        dotenv_map,
        ("LLM_BASE_URL", "OPENAI_BASE_URL", "TEXT_TO_SQL_BASE_URL"),
    )
    shared_model = _first_non_empty(
        dotenv_map,
        ("LLM_MODEL", "OPENAI_MODEL", "TEXT_TO_SQL_MODEL"),
    )
    timeout_raw = _first_non_empty(dotenv_map, ("LLM_TIMEOUT_SEC",))
    timeout_sec = int(timeout_raw) if timeout_raw.isdigit() and int(timeout_raw) > 0 else 60

    slot_candidates: list[tuple[int, str, str, str]] = []

    key1 = _first_non_empty(
        dotenv_map,
        (
            "LLM_API_KEY",
            "LLM_API_KEY_1",
            "TEXT_TO_SQL_API_KEY",
            "text-to-sql",
            "TEXT_TO_SQL_KEY",
            "TEXT_TO_SQL",
            "OPENAI_API_KEY",
            "API_KEY",
        ),
    )
    key2 = _first_non_empty(dotenv_map, ("LLM_API_KEY_2", "TEXT_TO_SQL_API_KEY_2"))
    key3 = _first_non_empty(dotenv_map, ("LLM_API_KEY_3", "TEXT_TO_SQL_API_KEY_3"))

    raw_slots: list[tuple[int, str]] = [
        (1, key1),
        (2, key2),
        (3, key3),
    ]

    # Also support comma-separated LLM_API_KEYS if someone supplies keys as a list
    multi_keys_raw = _first_non_empty(dotenv_map, ("LLM_API_KEYS",))
    if multi_keys_raw:
        for extra_idx, part in enumerate(multi_keys_raw.split(","), start=1):
            cleaned = part.strip()
            if cleaned:
                raw_slots.append((len(raw_slots) + extra_idx, cleaned))

    seen_keys: set[str] = set()
    for slot_num, k_val in raw_slots:
        if not k_val or k_val in seen_keys:
            continue
        seen_keys.add(k_val)
        slot_base = (
            _first_non_empty(
                dotenv_map,
                (f"LLM_BASE_URL_{slot_num}", f"TEXT_TO_SQL_BASE_URL_{slot_num}"),
            )
            or shared_base_url
        )
        slot_model = (
            _first_non_empty(
                dotenv_map,
                (f"LLM_MODEL_{slot_num}", f"TEXT_TO_SQL_MODEL_{slot_num}"),
            )
            or shared_model
        )
        slot_candidates.append((slot_num, k_val, slot_base, slot_model))
        if len(slot_candidates) >= 3:
            break

    missing: list[str] = []
    if not slot_candidates:
        missing.append("LLM_API_KEY")
    if not shared_base_url and not all(b for _, _, b, _ in slot_candidates):
        missing.append("LLM_BASE_URL")
    if not shared_model and not all(m for _, _, _, m in slot_candidates):
        missing.append("LLM_MODEL")

    if missing:
        raise RuntimeError(
            "LLM configuration is incomplete in .env. Please fill in: " + ", ".join(missing) + "."
        )

    configs: list[LlmConfig] = []
    for slot_num, k_val, b_val, m_val in slot_candidates:
        configs.append(
            LlmConfig(
                api_key=k_val,
                base_url=b_val.rstrip("/"),
                model=m_val,
                timeout_sec=timeout_sec,
                slot=slot_num,
                masked_key=mask_api_key(k_val),
            )
        )
    return configs


def get_llm_config(env_path: str | Path | None = None) -> LlmConfig:
    """Return primary configured LLM slot (backwards-compatible helper)."""
    return get_llm_configs(env_path)[0]


def is_llm_configured(env_path: str | Path | None = None) -> bool:
    try:
        get_llm_configs(env_path)
        return True
    except RuntimeError:
        return False
