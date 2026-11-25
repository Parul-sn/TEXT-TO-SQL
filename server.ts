import 'dotenv/config';
import { spawn, type ChildProcess } from 'child_process';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createNodeBackendRouter } from './node_backend.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PYTHON_PORT = Number(process.env.PYTHON_BACKEND_PORT) || 8765;

let pythonProc: ChildProcess | null = null;
let pythonAvailable = false;
let shuttingDown = false;
let nodeFallbackRouter: express.Router | null = null;

function ensureNodeFallback(): express.Router {
  if (!nodeFallbackRouter) {
    nodeFallbackRouter = createNodeBackendRouter();
  }
  return nodeFallbackRouter;
}

function startPythonBackend(): Promise<boolean> {
  return new Promise((resolve) => {
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    let settled = false;

    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        pythonAvailable = ok;
        resolve(ok);
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(pythonBin, ['-u', '-m', 'python_backend.server'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHON_BACKEND_PORT: String(PYTHON_PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.warn(
        `[server] Unable to launch Python backend (${err instanceof Error ? err.message : String(err)}); using in-process Node.js + sql.js backend.`
      );
      finish(false);
      return;
    }

    pythonProc = child;

    child.on('error', (err) => {
      console.warn(
        `[server] Python runtime unavailable (${err.message}); using in-process Node.js + sql.js backend.`
      );
      if (pythonProc === child) {
        pythonProc = null;
      }
      finish(false);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[python] ${chunk.toString()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[python] ${chunk.toString()}`);
    });

    child.on('exit', (code, signal) => {
      if (pythonProc === child) {
        pythonProc = null;
      }
      if (!settled) {
        console.warn(
          `[server] Python backend exited during startup (code=${code}, signal=${signal}); using in-process Node.js + sql.js backend.`
        );
        finish(false);
        return;
      }
      if (!shuttingDown && pythonAvailable) {
        console.error(
          `[python] backend exited unexpectedly (code=${code}, signal=${signal}); switching to Node.js fallback and attempting restart...`
        );
        pythonAvailable = false;
        setTimeout(() => {
          if (!shuttingDown) {
            void startPythonBackend();
          }
        }, 1000);
      }
    });

    void waitForPythonReady(8000).then((ready) => {
      if (!ready && !settled) {
        console.warn('[server] Python backend health check timed out; using in-process Node.js + sql.js backend.');
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill failure
        }
      }
      finish(ready);
    });
  });
}

async function waitForPythonReady(timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pythonProc) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/api/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(600, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Route /api/* to Python backend when running, or cleanly to the in-process Node.js + sql.js backend
app.use('/api', (req, res, next) => {
  if (!pythonAvailable || !pythonProc) {
    ensureNodeFallback()(req, res, next);
    return;
  }

  const targetUrl = `/api${req.url}`;
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = `127.0.0.1:${PYTHON_PORT}`;

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: PYTHON_PORT,
      path: targetUrl,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.warn(`[server] Python proxy failed (${err.message}); routing via Node.js + sql.js fallback.`);
    pythonAvailable = false;
    if (!res.headersSent) {
      ensureNodeFallback()(req, res, next);
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq, { end: true });
});

function cleanupChild() {
  shuttingDown = true;
  if (pythonProc && !pythonProc.killed) {
    try {
      pythonProc.kill('SIGTERM');
    } catch {
      // Ignore cleanup errors
    }
  }
}

process.on('SIGINT', () => {
  cleanupChild();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupChild();
  process.exit(0);
});
process.on('exit', cleanupChild);

async function startServer() {
  const hasPython = await startPythonBackend();
  if (!hasPython) {
    ensureNodeFallback();
  }

  const distPath = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    const modeLabel = hasPython
      ? `Python backend :${PYTHON_PORT}`
      : 'in-process Node.js + sql.js backend';
    console.log(`GraphSQL Studio listening on http://localhost:${PORT} (${modeLabel})`);
  });
}

startServer();
