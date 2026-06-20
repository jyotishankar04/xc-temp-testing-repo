import express, { type ErrorRequestHandler } from "express";
import fs from "node:fs";
import { ReliabilityClient } from "@xecurecode/reliability-sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("YOUR_")) {
    throw new Error(`${name} must be set before starting the test app`);
  }
  return value;
}

const API_KEY = requireEnv("XC_API_KEY");
const SERVICE_ID = requireEnv("XC_SERVICE_ID");

const reliability = new ReliabilityClient({
  apiKey: API_KEY,
  service_id: SERVICE_ID,
  mode: "production",
  endpoint: "http://127.0.0.1:4000/api/v1/ingest",
});

function loadDatabaseUrl(): string {
  const envText = fs.readFileSync("/home/devsuvam/Desktop/code-xc-backend/.env.dev", "utf8");
  const databaseUrl = envText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .find((line) => line.startsWith("DATABASE_URL="))
    ?.slice("DATABASE_URL=".length)
    .replace(/^['\"]|['\"]$/g, "");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

const app = express();
app.use(express.json());

async function captureAndFlush(req: express.Request, err: Error): Promise<void> {
  reliability.capture(err, req);
  await reliability.flush();
}

function makeError(name: string, message: string, stack: string): Error {
  const err = new Error(message);
  err.name = name;
  err.stack = `${name}: ${message}\n${stack}`;
  return err;
}

function dbPoolError() {
  return makeError(
    "PrismaClientKnownRequestError",
    "Too many connections: connection pool exhausted (pool_size=10, overflow=5). Waited 30000ms for a connection.",
    `    at PrismaPool._acquireConnection (/app/node_modules/@prisma/client/runtime/library.js:2341:19)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async UserRepository.findByEmail (/app/src/repositories/user.repository.ts:67:20)
    at async AuthService.validateSession (/app/src/services/auth.service.ts:134:16)
    at async SessionMiddleware.verify (/app/src/middleware/session.middleware.ts:28:14)`
  );
}

function paymentTimeoutError() {
  return makeError(
    "AxiosError",
    "timeout of 30000ms exceeded calling POST https://api.stripe.com/v1/charges",
    `    at RedirectableRequest.onTimeout (/app/node_modules/axios/lib/adapters/http.js:541:27)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async PaymentService.chargeCard (/app/src/services/payment.service.ts:89:18)
    at async OrderController.createOrder (/app/src/controllers/order.controller.ts:56:22)`
  );
}

function redisWrongtypeError() {
  return makeError(
    "ReplyError",
    "WRONGTYPE Operation against a key holding the wrong kind of value (key: rate:user:session_tokens)",
    `    at parseError (/app/node_modules/redis/dist/lib/client/index.js:344:14)
    at CacheService.get (/app/src/services/cache.service.ts:45:18)
    at RateLimiter.checkLimit (/app/src/middleware/rate-limiter.middleware.ts:67:22)`
  );
}

function jwtExpiredError() {
  return makeError(
    "JsonWebTokenError",
    "jwt expired — token issued at 2025-01-15T08:23:11.000Z expired at 2025-01-15T10:23:11.000Z",
    `    at /app/node_modules/jsonwebtoken/verify.js:84:21
    at AuthMiddleware.verifyToken (/app/src/middleware/auth.middleware.ts:56:18)`
  );
}

function s3AccessDeniedError() {
  return makeError(
    "S3ServiceException",
    "Access Denied: s3:PutObject on arn:aws:s3:::xc-prod-attachments/invoices/2025/01/ (403)",
    `    at de_PutObjectCommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/protocols/Aws_restXml.js:2891:25)
    at FileUploadService.upload (/app/src/services/file-upload.service.ts:123:18)`
  );
}

function configMissingError() {
  return makeError(
    "ConfigurationError",
    "Required environment variable DATABASE_REPLICA_URL is not set. Cannot initialize read replica pool.",
    `    at ConfigService.require (/app/src/config/config.service.ts:23:15)
    at ReportingService.init (/app/src/services/reporting.service.ts:45:30)`
  );
}

function heapOomError() {
  return makeError(
    "RangeError",
    "JavaScript heap out of memory: allocation of 2147483648 bytes failed (heap limit: 1.5 GB)",
    `    at ReportGenerator.buildRowData (/app/src/services/reporting/report-generator.service.ts:234:28)
    at ReportGenerator.exportToCsv (/app/src/services/reporting/report-generator.service.ts:189:32)`
  );
}

function grpcConnectionError() {
  return makeError(
    "StatusObject",
    "14 UNAVAILABLE: DNS resolution failed for endpoint 'notification-service.internal:50051'",
    `    at Object.onReceiveStatus (/app/node_modules/@grpc/grpc-js/build/src/client.js:192:52)
    at NotificationClient.send (/app/src/clients/notification.grpc.client.ts:89:22)`
  );
}

type ErrorRoute = {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  severity: "critical" | "high" | "medium";
};

const errorRoutes: ErrorRoute[] = [
  { id: "db-pool", label: "DB pool exhausted", description: "Prisma connection pool is exhausted.", endpoint: "/error/db-pool", severity: "critical" },
  { id: "payment-timeout", label: "Payment timeout", description: "Upstream payment service times out.", endpoint: "/error/payment-timeout", severity: "high" },
  { id: "redis-wrongtype", label: "Redis WRONGTYPE", description: "Bad cache value shape after deploy.", endpoint: "/error/redis-wrongtype", severity: "high" },
  { id: "jwt-expired", label: "JWT expired", description: "Auth token refresh failure.", endpoint: "/error/jwt-expired", severity: "medium" },
  { id: "s3-denied", label: "S3 access denied", description: "Storage permission issue.", endpoint: "/error/s3-denied", severity: "high" },
  { id: "config-missing", label: "Missing config", description: "Required env var is absent.", endpoint: "/error/config-missing", severity: "high" },
  { id: "heap-oom", label: "Heap OOM", description: "Memory pressure during report generation.", endpoint: "/error/heap-oom", severity: "critical" },
  { id: "grpc-unavailable", label: "gRPC unavailable", description: "Internal service discovery failure.", endpoint: "/error/grpc-unavailable", severity: "high" },
  { id: "uncaught-db", label: "Uncaught DB throw", description: "Same DB failure but via error middleware.", endpoint: "/error/uncaught-db", severity: "critical" },
];

const scenarios: ErrorRoute[] = [
  { id: "db-cascade", label: "DB cascade", description: "DB + auth + cache cascade.", endpoint: "/scenario/db-cascade", severity: "critical" },
  { id: "auth-storm", label: "Auth storm", description: "Burst of JWT expiry failures.", endpoint: "/scenario/auth-storm", severity: "medium" },
];

function renderHomePage() {
  const cards = (items: ErrorRoute[]) =>
    items
      .map(
        (item) => `
          <button class="card" data-endpoint="${item.endpoint}">
            <div class="card-top">
              <span class="badge ${item.severity}">${item.severity}</span>
              <span class="endpoint">${item.endpoint}</span>
            </div>
            <h3>${item.label}</h3>
            <p>${item.description}</p>
          </button>
        `,
      )
      .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>XecureCode Temp Error Lab</title>
      <style>
        :root {
          color-scheme: dark;
          --bg: #08111f;
          --panel: #0f1b2d;
          --panel-2: #13243b;
          --line: rgba(148, 163, 184, 0.18);
          --text: #e5eefb;
          --muted: #8ca0bd;
          --accent: #60a5fa;
          --critical: #f87171;
          --high: #fb923c;
          --medium: #facc15;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(96, 165, 250, 0.16), transparent 30%),
            radial-gradient(circle at top right, rgba(244, 63, 94, 0.12), transparent 32%),
            var(--bg);
          color: var(--text);
        }
        .wrap {
          max-width: 1180px;
          margin: 0 auto;
          padding: 32px 20px 40px;
        }
        .hero {
          display: grid;
          gap: 14px;
          margin-bottom: 24px;
          padding: 24px;
          border: 1px solid var(--line);
          border-radius: 24px;
          background: rgba(15, 27, 45, 0.82);
          backdrop-filter: blur(14px);
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--muted);
          font-size: 12px;
        }
        h1 {
          margin: 0;
          font-size: clamp(30px, 5vw, 52px);
          line-height: 1.02;
          max-width: 10ch;
        }
        .sub {
          margin: 0;
          max-width: 68ch;
          color: var(--muted);
          line-height: 1.6;
        }
        .meta {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .chip {
          border: 1px solid var(--line);
          background: rgba(255,255,255,0.04);
          padding: 8px 12px;
          border-radius: 999px;
          color: var(--text);
          font-size: 13px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 14px;
          margin-top: 14px;
        }
        .section {
          margin-top: 18px;
        }
        .section h2 {
          margin: 0 0 12px;
          font-size: 18px;
          color: #dbeafe;
        }
        .card {
          text-align: left;
          border: 1px solid var(--line);
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(19,36,59,0.92), rgba(15,27,45,0.92));
          color: var(--text);
          padding: 16px;
          min-height: 160px;
          cursor: pointer;
          transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
          display: grid;
          gap: 10px;
        }
        .card:hover {
          transform: translateY(-2px);
          border-color: rgba(96, 165, 250, 0.5);
        }
        .card h3 {
          margin: 0;
          font-size: 18px;
        }
        .card p {
          margin: 0;
          color: var(--muted);
          line-height: 1.5;
        }
        .card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          padding: 5px 10px;
          border-radius: 999px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #0b1020;
          font-weight: 700;
        }
        .badge.critical { background: var(--critical); }
        .badge.high { background: var(--high); }
        .badge.medium { background: var(--medium); }
        .endpoint {
          color: var(--muted);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .toolbar {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 14px;
        }
        .button {
          border: 1px solid rgba(96,165,250,0.28);
          background: rgba(96,165,250,0.12);
          color: var(--text);
          padding: 10px 14px;
          border-radius: 12px;
          cursor: pointer;
          font-weight: 600;
        }
        .button:hover {
          border-color: rgba(96,165,250,0.54);
          background: rgba(96,165,250,0.18);
        }
        .output {
          margin-top: 18px;
          border: 1px solid var(--line);
          border-radius: 18px;
          background: rgba(5, 12, 24, 0.55);
          padding: 14px;
        }
        .output-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          margin-bottom: 10px;
        }
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          color: #dbeafe;
          line-height: 1.55;
          font-size: 13px;
        }
        .hint {
          color: var(--muted);
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <section class="hero">
          <div class="eyebrow">XecureCode temp error lab</div>
          <h1>Click a button. Create an incident.</h1>
          <p class="sub">
            This page is a simple test harness. Each button triggers a different production-style failure inside the temp app,
            and the app reports it to the backend running on port 4000.
          </p>
          <div class="meta">
            <span class="chip">Service: ${SERVICE_ID}</span>
            <span class="chip">Backend: http://localhost:4000</span>
            <span class="chip">SDK: Node temp app</span>
          </div>
          <div class="toolbar">
            <button class="button" id="btn-health">Health check</button>
            <button class="button" id="btn-clear">Clear log</button>
          </div>
        </section>

        <section class="section">
          <h2>Single errors</h2>
          <div class="grid">${cards(errorRoutes)}</div>
        </section>

        <section class="section">
          <h2>Scenarios</h2>
          <div class="grid">${cards(scenarios)}</div>
        </section>

        <section class="output">
          <div class="output-head">
            <strong>Result log</strong>
            <span class="hint">Last request and response appear here.</span>
          </div>
          <pre id="log">Ready.</pre>
        </section>

        <section class="output">
          <div class="output-head">
            <strong>Recent incidents</strong>
            <span class="hint">Loaded from the backend for this service.</span>
          </div>
          <pre id="incidents">Loading...</pre>
        </section>
      </div>

      <script>
        const log = document.getElementById("log");
        const incidents = document.getElementById("incidents");

        function writeLog(value) {
          log.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        }

        function renderIncidents(payload) {
          const lines = ["Total incidents: " + payload.data.failureCount, ""];
          for (const item of payload.data.recentFailures) {
            lines.push(item.timestamp + " | " + String(item.severity).toUpperCase() + " | " + item.errorType);
            lines.push(item.errorMessage);
            lines.push("fingerprint: " + item.fingerprint + " | occurrences: " + item.occurrenceCount);
            lines.push("");
          }
          incidents.textContent = lines.join("\\n").trim() || "No incidents yet.";
        }

        async function refreshIncidents() {
          try {
            const response = await fetch("/api/recent");
            const payload = await response.json();
            if (payload.success) {
              renderIncidents(payload);
            } else {
              incidents.textContent = "Failed to load incidents.";
            }
          } catch (error) {
            incidents.textContent = "Failed to load incidents: " + String(error);
          }
        }

        async function runEndpoint(endpoint) {
          writeLog({ status: "running", endpoint });
          try {
            const response = await fetch(endpoint, { headers: { "x-requested-with": "error-lab" } });
            const contentType = response.headers.get("content-type") || "";
            const body = contentType.includes("application/json")
              ? await response.json()
              : await response.text();
            writeLog({ endpoint, status: response.status, ok: response.ok, body });
            await refreshIncidents();
          } catch (error) {
            writeLog({ endpoint, error: String(error) });
          }
        }

        document.querySelectorAll("[data-endpoint]").forEach((button) => {
          button.addEventListener("click", () => runEndpoint(button.getAttribute("data-endpoint")));
        });

        document.getElementById("btn-health").addEventListener("click", () => runEndpoint("/health"));
        document.getElementById("btn-clear").addEventListener("click", () => writeLog("Ready."));
        refreshIncidents();
      </script>
    </body>
  </html>`;
}

app.get("/", (_req, res) => {
  res.type("html").send(renderHomePage());
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: SERVICE_ID, ts: new Date().toISOString() });
});

app.get("/api/recent", async (_req, res, next) => {
  try {
    const { default: pg } = await import("/home/devsuvam/Desktop/code-xc-backend/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js");
    const client = new pg.Client({ connectionString: loadDatabaseUrl() });
    await client.connect();
    try {
      const [failureCountResult, recentFailuresResult] = await Promise.all([
        client.query('SELECT COUNT(*)::int AS count FROM "FailureEvent" WHERE "serviceId" = $1', [SERVICE_ID]),
        client.query(
          'SELECT "id", "errorMessage", "fingerprint", "occurrenceCount", "timestamp", "severity", "errorType" FROM "FailureEvent" WHERE "serviceId" = $1 ORDER BY "timestamp" DESC LIMIT 8',
          [SERVICE_ID],
        ),
      ]);

      res.json({
        success: true,
        data: {
          failureCount: failureCountResult.rows[0]?.count ?? 0,
          recentFailures: recentFailuresResult.rows,
        },
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/error/db-pool", async (req, res) => {
  const err = dbPoolError();
  await captureAndFlush(req, err);
  res.status(503).json({ error: err.message, type: "DB_POOL_EXHAUSTED" });
});

app.get("/error/payment-timeout", async (req, res) => {
  const err = paymentTimeoutError();
  await captureAndFlush(req, err);
  res.status(504).json({ error: err.message, type: "UPSTREAM_TIMEOUT" });
});

app.get("/error/redis-wrongtype", async (req, res) => {
  const err = redisWrongtypeError();
  await captureAndFlush(req, err);
  res.status(500).json({ error: err.message, type: "CACHE_ERROR" });
});

app.get("/error/jwt-expired", async (req, res) => {
  const err = jwtExpiredError();
  await captureAndFlush(req, err);
  res.status(401).json({ error: err.message, type: "AUTH_FAILURE" });
});

app.get("/error/s3-denied", async (req, res) => {
  const err = s3AccessDeniedError();
  await captureAndFlush(req, err);
  res.status(500).json({ error: err.message, type: "STORAGE_ERROR" });
});

app.get("/error/config-missing", async (req, res) => {
  const err = configMissingError();
  await captureAndFlush(req, err);
  res.status(500).json({ error: err.message, type: "CONFIG_ERROR" });
});

app.get("/error/heap-oom", async (req, res) => {
  const err = heapOomError();
  await captureAndFlush(req, err);
  res.status(500).json({ error: err.message, type: "MEMORY_ERROR" });
});

app.get("/error/grpc-unavailable", async (req, res) => {
  const err = grpcConnectionError();
  await captureAndFlush(req, err);
  res.status(502).json({ error: err.message, type: "SERVICE_MESH_ERROR" });
});

app.get("/error/uncaught-db", (_req, _res) => {
  throw dbPoolError();
});

app.get("/scenario/db-cascade", async (req, res) => {
  const errors = [dbPoolError(), jwtExpiredError(), redisWrongtypeError()];
  for (const err of errors) {
    reliability.capture(err, req);
    await new Promise((r) => setTimeout(r, 150));
  }
  await reliability.flush();
  res.json({
    sent: errors.length,
    message: "Cascading failure scenario emitted",
    errors: errors.map((e) => e.name),
  });
});

app.get("/scenario/auth-storm", async (req, res) => {
  const count = 5;
  for (let i = 0; i < count; i++) {
    reliability.capture(jwtExpiredError(), req);
    await new Promise((r) => setTimeout(r, 110));
  }
  await reliability.flush();
  res.json({ sent: count, message: "Auth failure storm emitted" });
});

app.use(reliability.middleware());

const finalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ error: String((err as Error).message) });
};
app.use(finalErrorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nXC Node test app → http://localhost:${PORT}`);
  console.log(`Service: ${SERVICE_ID}  |  Backend: http://localhost:4000/api/v1/ingest\n`);
});

process.on("SIGTERM", async () => {
  await reliability.flush();
  process.exit(0);
});
