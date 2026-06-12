/**
 * XecureCode Scenario Runner
 *
 * Sends payloads DIRECTLY to the backend (bypassing SDK client-side dedup) so
 * you can test case grouping, severity escalation, and RCA quality end-to-end.
 *
 * Usage:
 *   npx ts-node scenario-runner.ts                   # run all scenarios
 *   npx ts-node scenario-runner.ts db-pool           # single scenario, 1 send
 *   npx ts-node scenario-runner.ts db-pool 25        # send db-pool error 25×
 *   npx ts-node scenario-runner.ts severity-climb    # escalation test (21 sends)
 *
 * Prerequisites:
 *   XC_API_KEY=<your key>  XC_SERVICE_ID=<your service id>  npx ts-node ...
 */

import * as crypto from "crypto";
import * as http from "http";
import * as os from "os";

const API_KEY = process.env.XC_API_KEY || "";
const SERVICE_ID = process.env.XC_SERVICE_ID || "";
const BACKEND = process.env.XC_BACKEND || "http://localhost:4000/api/v1/ingest";

if (!API_KEY || !SERVICE_ID) {
  console.error("ERROR: XC_API_KEY and XC_SERVICE_ID must be set.\n");
  console.error("  XC_API_KEY=xxx XC_SERVICE_ID=yyy npx ts-node scenario-runner.ts");
  process.exit(1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ErrorPayload {
  message: string;
  name: string;
  stack: string;
  fingerprint: string;
  timestamp: number;
  service: string;
  environment: string;
  occurrenceCount: number;
  severity: string;
  errorType: string;
  serviceContext: object;
  requestContext?: object;
}

type Scenario = {
  name: string;
  description: string;
  payload: Omit<ErrorPayload, "fingerprint" | "timestamp" | "service" | "occurrenceCount" | "serviceContext">;
};

// ─── Payload builder ──────────────────────────────────────────────────────────

function buildFingerprint(message: string, stack: string, serviceId: string): string {
  const firstTenLines = stack.split("\n").slice(0, 10).join("\n");
  return crypto.createHash("sha256").update(message + firstTenLines + serviceId).digest("hex");
}

function buildPayload(scenario: Scenario, count: number): ErrorPayload {
  const { message, stack } = scenario.payload;
  return {
    ...scenario.payload,
    fingerprint: buildFingerprint(message, stack, SERVICE_ID),
    timestamp: Date.now(),
    service: SERVICE_ID,
    occurrenceCount: count,
    serviceContext: {
      pid: process.pid,
      runtime: "node",
      runtimeVersion: process.version,
      nodeVersion: process.version,
      platform: process.platform,
      hostname: os.hostname(),
    },
  };
}

// ─── HTTP sender ──────────────────────────────────────────────────────────────

async function post(payload: ErrorPayload): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(BACKEND);
    const options = {
      hostname: url.hostname,
      port: url.port || 4000,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "xc-api-key": API_KEY,
        "xc-service-id": SERVICE_ID,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Scenario definitions ─────────────────────────────────────────────────────

const SCENARIOS: Record<string, Scenario> = {
  "db-pool": {
    name: "DB Pool Exhaustion",
    description: "PrismaClientKnownRequestError — connection pool limit hit",
    payload: {
      message: "Too many connections: connection pool exhausted (pool_size=10, overflow=5). Waited 30000ms for a connection.",
      name: "PrismaClientKnownRequestError",
      stack: `PrismaClientKnownRequestError: Too many connections: connection pool exhausted (pool_size=10, overflow=5). Waited 30000ms for a connection.
    at PrismaPool._acquireConnection (/app/node_modules/@prisma/client/runtime/library.js:2341:19)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async UserRepository.findByEmail (/app/src/repositories/user.repository.ts:67:20)
    at async AuthService.validateSession (/app/src/services/auth.service.ts:134:16)
    at async SessionMiddleware.verify (/app/src/middleware/session.middleware.ts:28:14)
    at async Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at async next (/app/node_modules/express/lib/router/route.js:144:13)
    at async /app/src/routes/dashboard.routes.ts:45:5`,
      environment: "production",
      severity: "critical",
      errorType: "DATABASE",
      requestContext: {
        method: "GET",
        url: "/api/dashboard/overview",
        ip: "10.0.1.45",
        userAgent: "Mozilla/5.0 (production-traffic)",
      },
    },
  },

  "payment-timeout": {
    name: "Payment Service Timeout",
    description: "AxiosError — Stripe API unreachable after 30s",
    payload: {
      message: "timeout of 30000ms exceeded calling POST https://api.stripe.com/v1/charges",
      name: "AxiosError",
      stack: `AxiosError: timeout of 30000ms exceeded calling POST https://api.stripe.com/v1/charges
    at RedirectableRequest.onTimeout (/app/node_modules/axios/lib/adapters/http.js:541:27)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async PaymentService.chargeCard (/app/src/services/payment.service.ts:89:18)
    at async OrderController.createOrder (/app/src/controllers/order.controller.ts:56:22)
    at async OrderController.checkout (/app/src/controllers/order.controller.ts:78:14)
    at async /app/src/routes/orders.routes.ts:23:5`,
      environment: "production",
      severity: "critical",
      errorType: "NETWORK",
      requestContext: {
        method: "POST",
        url: "/api/orders/checkout",
        ip: "10.0.2.78",
        userAgent: "XC-Mobile/3.2.1",
      },
    },
  },

  "jwt-expired": {
    name: "JWT Token Expired",
    description: "JsonWebTokenError — expired tokens not being refreshed (bad deploy)",
    payload: {
      message: "jwt expired — token issued at 2025-01-15T08:23:11.000Z expired at 2025-01-15T10:23:11.000Z",
      name: "JsonWebTokenError",
      stack: `JsonWebTokenError: jwt expired — token issued at 2025-01-15T08:23:11.000Z expired at 2025-01-15T10:23:11.000Z
    at /app/node_modules/jsonwebtoken/verify.js:84:21
    at getSecret (/app/node_modules/jsonwebtoken/verify.js:90:14)
    at module.exports [as verify] (/app/node_modules/jsonwebtoken/verify.js:64:10)
    at AuthMiddleware.verifyToken (/app/src/middleware/auth.middleware.ts:56:18)
    at AuthMiddleware.handle (/app/src/middleware/auth.middleware.ts:29:14)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/src/routes/protected.routes.ts:8:5`,
      environment: "production",
      severity: "medium",
      errorType: "AUTH",
      requestContext: {
        method: "GET",
        url: "/api/user/profile",
        ip: "192.168.1.100",
      },
    },
  },

  "redis-wrongtype": {
    name: "Redis Key Type Mismatch",
    description: "ReplyError — bad deploy changed cache value format",
    payload: {
      message: "WRONGTYPE Operation against a key holding the wrong kind of value (key: rate:user:session_tokens)",
      name: "ReplyError",
      stack: `ReplyError: WRONGTYPE Operation against a key holding the wrong kind of value (key: rate:user:session_tokens)
    at parseError (/app/node_modules/redis/dist/lib/client/index.js:344:14)
    at CacheService.get (/app/src/services/cache.service.ts:45:18)
    at RateLimiter.checkLimit (/app/src/middleware/rate-limiter.middleware.ts:67:22)
    at RateLimiter.handle (/app/src/middleware/rate-limiter.middleware.ts:34:18)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/src/routes/api.routes.ts:12:5`,
      environment: "production",
      severity: "medium",
      errorType: "RUNTIME",
      requestContext: {
        method: "POST",
        url: "/api/v1/events",
        ip: "10.0.5.12",
      },
    },
  },

  "sqlalchemy-pool": {
    name: "SQLAlchemy Pool Timeout",
    description: "Python — DB connection pool backed up under load",
    payload: {
      message: "QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00 (Background on this error at: https://sqlalche.me/e/14/3o7r)",
      name: "TimeoutError",
      stack: `Traceback (most recent call last):
  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/pool/impl.py", line 145, in _do_get
  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/pool/base.py", line 263, in _checkout
  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/engine/base.py", line 3165, in connect
  File "/app/app/repositories/order_repository.py", line 78, in get_pending_orders
    return db.execute(select(Order).where(Order.status == "pending")).scalars().all()
  File "/app/app/services/order_service.py", line 134, in process_batch
    pending = self.repo.get_pending_orders(limit=500)
  File "/app/app/tasks/order_processor.py", line 45, in run
    service.process_batch()
TimeoutError: QueuePool limit of size 5 overflow 10 reached`,
      environment: "production",
      severity: "critical",
      errorType: "DATABASE",
      requestContext: {
        method: "POST",
        url: "/tasks/order-processor/run",
        ip: "10.0.3.21",
      },
    },
  },

  "celery-timeout": {
    name: "Celery Task Timeout",
    description: "Python — async email task killed by soft time limit",
    payload: {
      message: "SoftTimeLimitExceeded: Task app.tasks.email_sender.send_bulk_emails[c3f2a1b0] exceeded soft time limit (300s). Sending SIGUSR1.",
      name: "RuntimeError",
      stack: `Traceback (most recent call last):
  File "/app/venv/lib/python3.12/site-packages/celery/app/trace.py", line 450, in trace_task
  File "/app/venv/lib/python3.12/site-packages/billiard/pool.py", line 358, in _handler
  File "/app/app/tasks/email_sender.py", line 89, in send_bulk_emails
    result = email_service.send_batch(recipients, template_id)
  File "/app/app/services/email_service.py", line 234, in send_batch
    self._do_send(chunk)
  File "/app/app/services/email_service.py", line 267, in _do_send
    resp = self.smtp_client.sendmail(from_addr, to_addrs, msg.as_string())
RuntimeError: SoftTimeLimitExceeded`,
      environment: "production",
      severity: "medium",
      errorType: "RUNTIME",
    },
  },

  "heap-oom": {
    name: "Heap Out of Memory",
    description: "RangeError — large report export blows JS heap limit",
    payload: {
      message: "JavaScript heap out of memory: allocation of 2147483648 bytes failed (heap limit: 1.5 GB)",
      name: "RangeError",
      stack: `RangeError: JavaScript heap out of memory: allocation of 2147483648 bytes failed (heap limit: 1.5 GB)
    at Array.from (<anonymous>)
    at ReportGenerator.buildRowData (/app/src/services/reporting/report-generator.service.ts:234:28)
    at ReportGenerator.exportToCsv (/app/src/services/reporting/report-generator.service.ts:189:32)
    at ReportController.downloadReport (/app/src/controllers/report.controller.ts:67:22)
    at /app/src/routes/reports.routes.ts:18:5`,
      environment: "production",
      severity: "critical",
      errorType: "RUNTIME",
      requestContext: {
        method: "GET",
        url: "/api/reports/export?type=full&year=2025",
        ip: "10.0.4.88",
      },
    },
  },
};

// ─── Runner logic ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendScenario(
  key: string,
  scenario: Scenario,
  count: number,
  intervalMs: number,
  label: string
) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${label}] ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(`  Sending ${count}× with ${intervalMs / 1000}s interval`);
  console.log(`${"─".repeat(60)}`);

  let ok = 0;
  let fail = 0;

  for (let i = 1; i <= count; i++) {
    const payload = buildPayload(scenario, i);
    try {
      const { status } = await post(payload);
      if (status >= 200 && status < 300) {
        ok++;
        process.stdout.write(`  [${i}/${count}] ✓ ${status}\n`);
      } else {
        fail++;
        process.stdout.write(`  [${i}/${count}] ✗ HTTP ${status}\n`);
      }
    } catch (err) {
      fail++;
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  [${i}/${count}] ✗ ${message}\n`);
    }

    if (i < count) {
      await sleep(intervalMs);
    }
  }

  console.log(`  Result: ${ok} ok, ${fail} failed`);
  if (fail > 0) {
    console.log(`  Check that the backend is running at ${BACKEND}`);
  }
}

async function runAll() {
  const keys = Object.keys(SCENARIOS);
  for (const key of keys) {
    await sendScenario(key, SCENARIOS[key], 1, 0, "SINGLE");
    await sleep(500);
  }
}

async function runSeverityClimb(scenarioKey: string) {
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioKey}`);
    process.exit(1);
  }

  // Backend has 10s dedup — wait 12s between each to ensure all are stored
  console.log(`\nSeverity escalation test for: ${scenario.name}`);
  console.log("Sending 21 occurrences with 12s intervals to climb LOW→MED→HIGH");
  console.log("Expected: occurrence 1 = LOW, 5 = MEDIUM, 20 = HIGH\n");

  await sendScenario(scenarioKey, scenario, 21, 12_000, "SEVERITY-CLIMB");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [, , scenarioKey, countArg] = process.argv;

  console.log(`\nXecureCode Scenario Runner`);
  console.log(`Backend: ${BACKEND}`);
  console.log(`Service: ${SERVICE_ID}\n`);

  if (!scenarioKey || scenarioKey === "all") {
    console.log("Running all scenarios (1× each)...");
    await runAll();
    return;
  }

  if (scenarioKey === "severity-climb") {
    const target = countArg || "db-pool";
    await runSeverityClimb(target);
    return;
  }

  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`Unknown scenario: "${scenarioKey}"\n`);
    console.error("Available scenarios:");
    for (const [k, s] of Object.entries(SCENARIOS)) {
      console.error(`  ${k.padEnd(22)} ${s.name}`);
    }
    console.error("\n  severity-climb [scenario]  — send 21× with 12s intervals");
    process.exit(1);
  }

  const count = parseInt(countArg || "1", 10);
  // For single sends, no delay needed. For multiple, use 12s to bypass 10s backend dedup.
  const intervalMs = count > 1 ? 12_000 : 0;
  await sendScenario(scenarioKey, scenario, count, intervalMs, "SCENARIO");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
