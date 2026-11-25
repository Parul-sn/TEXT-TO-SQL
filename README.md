# GraphSQL Studio — Anomaly-Aware Multi-Path Text-to-SQL Workbench

**GraphSQL Studio** implements the **AAMG-SQL** (*Anomaly-Aware Multi-Path Graph-Guided Text-to-SQL*) pipeline: an interactive SQL generation, schema graph visualization, data quality remediation, missing-value imputation, and official Spider benchmark evaluation workbench.

---

## Key Capabilities

1. **Multi-Input Text-to-SQL**
   - **Text-Only Mode (No Database Attached):** Generates normalized SQLite `CREATE TABLE` DDL and candidate queries purely from natural language.
   - **`.sql` Script & `.db` / `.sqlite` Binary Upload:** Profiles uploaded relational databases, builds column-level foreign-key graphs, and executes generated SQL live.
2. **Bounded 5-Retry Execution-Guided Self-Healing**
   - Runs generated SQL against SQLite and feeds exact runtime error diagnostics back to the configured LLM for up to **5 repair iterations** (6 total attempts).
3. **Multi-Path Graph Generation & Resilience Scoring**
   - Enumerates competing join routes between tables, scores them using graph edge anomaly penalties and missingness rates, and displays the **Selected Best Query** alongside all **Not-Selected Alternatives**.
4. **Interactive Schema & Query Graph Visualization**
   - Column-to-column schema relationship graph highlighting active join paths and referenced columns, plus a relational **Query Execution DAG** (`SCAN → JOIN → FILTER → GROUP/AGGREGATE → SORT → LIMIT → PROJECT`).
5. **Missing-Value Imputation & Anomaly Remediation**
   - Approximates missing values via **Conditional Peer-Group Mean / Mode** and tags every filled value clearly as **`GUESSED · WAS MISSING`** with source-column provenance.
   - Detects IQR numeric outliers, negative domain violations, orphan foreign keys, and casing/whitespace fragmentation with one-click SQL cleaning and snapshot rollback.
6. **Official Yale Spider 1.0 Dev Benchmark (`1,034` Tasks)**
   - Local Spider 1.0 Dev dataset (`data/spider/dev.json` + `data/spider/database/`) supporting user-specified test case counts (`N`), start offsets, and hardness filters (`Easy`, `Medium`, `Hard`, `Extra Hard`) with real **Execution Accuracy (EX)**, **First-Pass vs. Self-Healed Accuracy**, and **Component Match F1**.
7. **Light & Dark Themes, Showcase Examples, & Project Report**
   - Includes 5 built-in showcase datasets and an exportable final project report with architectural diagrams and step-by-step methodology.

---

## Architecture

- **Frontend:** React 19, Vite, Tailwind CSS, TypeScript (`src/`)
- **Primary Backend:** Python 3.11 standard library (`python_backend/` using native `sqlite3` & `ThreadingHTTPServer`)
- **Gateway & Portable Fallback:** Express + Vite/static gateway (`server.ts`) that runs Python 3 when available and automatically falls back to an in-process Node.js + WebAssembly SQLite (`node_backend.ts` + `sql.js`) runtime in Node-only environments.

---

## Quick Start (Local Setup)

### Prerequisites
- **Node.js** `20+` (or `22+`) and **npm**
- **Python 3.10+** *(recommended; uses Python standard library only, no `pip install` needed; automatically falls back to Node.js `sql.js` if Python is absent)*

### 1. Configure `.env`
All interconnected ports, URLs, and Spider dataset paths are pre-configured in `.env`. Open `.env` and fill in up to **3 API keys** (automatic failover from Key 1 → Key 2 → Key 3 whenever an error or token/rate limit is hit), plus your endpoint base URL and model name:

```env
LLM_API_KEY="your-primary-api-key"
LLM_API_KEY_2="your-second-backup-key"     # optional: used automatically if Key 1 hits an error/token limit
LLM_API_KEY_3="your-third-backup-key"      # optional: used automatically if Key 2 hits an error/token limit
LLM_BASE_URL="https://api.openai.com/v1"   # or Groq, OpenRouter, Together, Ollama, etc.
LLM_MODEL="your-model-name"                # e.g. gpt-4o-mini, openai/gpt-oss-120b, llama-3.3-70b-versatile
LLM_TIMEOUT_SEC="60"                       # optional; defaults to 60 if left blank

# Pre-configured interconnected settings
PORT="3000"
PYTHON_BACKEND_PORT="8765"
APP_URL="http://localhost:3000"
SPIDER_DATA_DIR="data/spider"
```

Common OpenAI-compatible `LLM_BASE_URL` values:
- **OpenAI:** `https://api.openai.com/v1`
- **Groq:** `https://api.groq.com/openai/v1`
- **OpenRouter:** `https://openrouter.ai/api/v1`
- **Together AI:** `https://api.together.xyz/v1`
- **Local Ollama:** `http://localhost:11434/v1`

> Changes to `.env` are reloaded dynamically on every request—you do not need to restart the server after saving `.env`. Candidate SQL queries are automatically compared by **calculated execution + anomaly cost** (`EXPLAIN QUERY PLAN` scan/sort cost, join hops, edge anomaly penalty, missing-data loss, semantic alignment, and latency) and the **lowest-cost valid query** is selected.

### 2. Install & Run

```bash
npm install
npm run dev
```

Open **`http://localhost:3000`** in your browser.

### 3. Production Build & Start

```bash
npm run build
NODE_ENV=production npm start
```

---

## Running Tests

```bash
# Python backend test suite (stdlib unittest)
python3 -m unittest discover -s python_backend/tests -v

# Shared graph, data quality, and Spider comparator tests
npx tsx --test src/shared/core.test.ts

# TypeScript check
npm run lint
```

---

## Project Structure

```text
├── .env / .env.example          # Open LLM & runtime configuration
├── server.ts                    # Express gateway + Python launcher / Node fallback
├── node_backend.ts              # Portable in-process Node.js + sql.js backend
├── python_backend/              # Pure-stdlib Python 3 + sqlite3 backend
│   ├── server.py                # ThreadingHTTPServer API endpoints
│   ├── env_loader.py            # Dynamic .env reader & LLM config resolver
│   ├── llm_sql.py               # OpenAI-compatible Text-to-SQL & 5-retry repair
│   ├── db_manager.py            # Session SQLite manager, uploads & snapshot reset
│   ├── data_quality.py          # Missingness imputation & anomaly detection
│   ├── graph_engine.py          # Multi-path join enumeration & Query Graph parser
│   ├── spider_benchmark.py      # Official Spider 1.0 Dev runner & accuracy metrics
│   └── tests/test_core.py       # Python backend unit tests
├── data/spider/                 # Saved official Yale Spider 1.0 Dev dataset (1,034 tasks)
└── src/                         # React + Tailwind frontend & shared pure engines
```
