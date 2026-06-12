import express, { type ErrorRequestHandler } from "express";
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
});

const app = express();
app.use(express.json());

// ─── Realistic error factories ─────────────────────────────────────────────────

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
    at async SessionMiddleware.verify (/app/src/middleware/session.middleware.ts:28:14)
    at async Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at async next (/app/node_modules/express/lib/router/route.js:144:13)
    at async /app/src/routes/dashboard.routes.ts:45:5`
  );
}

function paymentTimeoutError() {
  return makeError(
    "AxiosError",
    "timeout of 30000ms exceeded calling POST https://api.stripe.com/v1/charges",
    `    at RedirectableRequest.onTimeout (/app/node_modules/axios/lib/adapters/http.js:541:27)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async PaymentService.chargeCard (/app/src/services/payment.service.ts:89:18)
    at async OrderController.createOrder (/app/src/controllers/order.controller.ts:56:22)
    at async OrderController.checkout (/app/src/controllers/order.controller.ts:78:14)
    at async /app/src/routes/orders.routes.ts:23:5`
  );
}

function redisWrongtypeError() {
  return makeError(
    "ReplyError",
    "WRONGTYPE Operation against a key holding the wrong kind of value (key: rate:user:session_tokens)",
    `    at parseError (/app/node_modules/redis/dist/lib/client/index.js:344:14)
    at CacheService.get (/app/src/services/cache.service.ts:45:18)
    at RateLimiter.checkLimit (/app/src/middleware/rate-limiter.middleware.ts:67:22)
    at RateLimiter.handle (/app/src/middleware/rate-limiter.middleware.ts:34:18)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/src/routes/api.routes.ts:12:5`
  );
}

function jwtExpiredError() {
  return makeError(
    "JsonWebTokenError",
    "jwt expired — token issued at 2025-01-15T08:23:11.000Z expired at 2025-01-15T10:23:11.000Z",
    `    at /app/node_modules/jsonwebtoken/verify.js:84:21
    at getSecret (/app/node_modules/jsonwebtoken/verify.js:90:14)
    at module.exports [as verify] (/app/node_modules/jsonwebtoken/verify.js:64:10)
    at AuthMiddleware.verifyToken (/app/src/middleware/auth.middleware.ts:56:18)
    at AuthMiddleware.handle (/app/src/middleware/auth.middleware.ts:29:14)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/src/routes/protected.routes.ts:8:5`
  );
}

function s3AccessDeniedError() {
  return makeError(
    "S3ServiceException",
    "Access Denied: s3:PutObject on arn:aws:s3:::xc-prod-attachments/invoices/2025/01/ (403)",
    `    at throwDefaultError (/app/node_modules/@aws-sdk/smithy-client/dist-cjs/default-error-handler.js:8:22)
    at de_PutObjectCommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/protocols/Aws_restXml.js:2891:25)
    at FileUploadService.upload (/app/src/services/file-upload.service.ts:123:18)
    at async DocumentController.saveAttachment (/app/src/controllers/document.controller.ts:78:22)
    at async DocumentController.create (/app/src/controllers/document.controller.ts:45:14)
    at async /app/src/routes/documents.routes.ts:34:5`
  );
}

function configMissingError() {
  return makeError(
    "ConfigurationError",
    "Required environment variable DATABASE_REPLICA_URL is not set. Cannot initialize read replica pool.",
    `    at ConfigService.require (/app/src/config/config.service.ts:23:15)
    at ConfigService.getDatabaseConfig (/app/src/config/config.service.ts:67:18)
    at ReportingService.init (/app/src/services/reporting.service.ts:45:30)
    at DatabaseModule.onModuleInit (/app/src/modules/database/database.module.ts:34:18)
    at /app/src/main.ts:89:5`
  );
}

function heapOomError() {
  return makeError(
    "RangeError",
    "JavaScript heap out of memory: allocation of 2147483648 bytes failed (heap limit: 1.5 GB)",
    `    at Array.from (<anonymous>)
    at ReportGenerator.buildRowData (/app/src/services/reporting/report-generator.service.ts:234:28)
    at ReportGenerator.exportToCsv (/app/src/services/reporting/report-generator.service.ts:189:32)
    at ReportController.downloadReport (/app/src/controllers/report.controller.ts:67:22)
    at /app/src/routes/reports.routes.ts:18:5`
  );
}

function grpcConnectionError() {
  return makeError(
    "StatusObject",
    "14 UNAVAILABLE: DNS resolution failed for endpoint 'notification-service.internal:50051'",
    `    at callErrorFromStatus (/app/node_modules/@grpc/grpc-js/build/src/call.js:30:26)
    at Object.onReceiveStatus (/app/node_modules/@grpc/grpc-js/build/src/client.js:192:52)
    at NotificationClient.send (/app/src/clients/notification.grpc.client.ts:89:22)
    at EventBus.dispatch (/app/src/events/event-bus.ts:134:18)
    at OrderService.afterPurchase (/app/src/services/order.service.ts:267:22)
    at /app/src/routes/checkout.routes.ts:56:5`
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: SERVICE_ID, ts: new Date().toISOString() });
});

// DB connection pool exhausted — most common production incident
app.get("/error/db-pool", (req, res) => {
  const err = dbPoolError();
  reliability.capture(err, req);
  res.status(503).json({ error: err.message, type: "DB_POOL_EXHAUSTED" });
});

// Upstream payment service timeout
app.get("/error/payment-timeout", (req, res) => {
  const err = paymentTimeoutError();
  reliability.capture(err, req);
  res.status(504).json({ error: err.message, type: "UPSTREAM_TIMEOUT" });
});

// Redis cache key type mismatch — bad deploy changed value format
app.get("/error/redis-wrongtype", (req, res) => {
  const err = redisWrongtypeError();
  reliability.capture(err, req);
  res.status(500).json({ error: err.message, type: "CACHE_ERROR" });
});

// JWT expired — token not refreshed, causes auth cascade
app.get("/error/jwt-expired", (req, res) => {
  const err = jwtExpiredError();
  reliability.capture(err, req);
  res.status(401).json({ error: err.message, type: "AUTH_FAILURE" });
});

// S3 IAM permission missing — bad policy update
app.get("/error/s3-denied", (req, res) => {
  const err = s3AccessDeniedError();
  reliability.capture(err, req);
  res.status(500).json({ error: err.message, type: "STORAGE_ERROR" });
});

// Missing env var — bad deployment config
app.get("/error/config-missing", (req, res) => {
  const err = configMissingError();
  reliability.capture(err, req);
  res.status(500).json({ error: err.message, type: "CONFIG_ERROR" });
});

// OOM during large report export
app.get("/error/heap-oom", (req, res) => {
  const err = heapOomError();
  reliability.capture(err, req);
  res.status(500).json({ error: err.message, type: "MEMORY_ERROR" });
});

// gRPC service discovery failure
app.get("/error/grpc-unavailable", (req, res) => {
  const err = grpcConnectionError();
  reliability.capture(err, req);
  res.status(502).json({ error: err.message, type: "SERVICE_MESH_ERROR" });
});

// Unhandled throw — caught by Express error middleware
app.get("/error/uncaught-db", (_req, _res) => {
  throw dbPoolError();
});

// Cascade scenario: DB pool fails → auth falls back → cache error surfaces
// All three sent in one request to simulate cascading failure
app.get("/scenario/db-cascade", async (req, res) => {
  const errors = [dbPoolError(), jwtExpiredError(), redisWrongtypeError()];
  for (const err of errors) {
    reliability.capture(err, req);
    await new Promise((r) => setTimeout(r, 150));
  }
  res.json({
    sent: errors.length,
    message: "Cascading failure scenario emitted",
    errors: errors.map((e) => e.name),
  });
});

// Auth storm: 5 auth failures quickly — simulates token refresh bug after deploy
app.get("/scenario/auth-storm", async (req, res) => {
  const count = 5;
  for (let i = 0; i < count; i++) {
    reliability.capture(jwtExpiredError(), req);
    await new Promise((r) => setTimeout(r, 110));
  }
  res.json({ sent: count, message: "Auth failure storm emitted" });
});

// ─── Error middleware ─────────────────────────────────────────────────────────
app.use(reliability.middleware());
const finalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ error: String(err.message) });
};
app.use(finalErrorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nXC Node test app → http://localhost:${PORT}`);
  console.log(`Service: ${SERVICE_ID}  |  Backend: http://localhost:4000/api/v1/ingest\n`);
  console.log("Error endpoints (single capture):");
  console.log("  GET /error/db-pool           PrismaClientKnownRequestError — pool exhausted");
  console.log("  GET /error/payment-timeout   AxiosError — Stripe timeout");
  console.log("  GET /error/redis-wrongtype   ReplyError — wrong key type");
  console.log("  GET /error/jwt-expired       JsonWebTokenError — expired token");
  console.log("  GET /error/s3-denied         S3ServiceException — IAM denied");
  console.log("  GET /error/config-missing    ConfigurationError — missing env var");
  console.log("  GET /error/heap-oom          RangeError — JS heap OOM");
  console.log("  GET /error/grpc-unavailable  StatusObject — gRPC DNS failure");
  console.log("  GET /error/uncaught-db       same DB error, caught by middleware");
  console.log("\nScenario endpoints (multiple errors, simulated cascades):");
  console.log("  GET /scenario/db-cascade     DB + auth + cache cascade");
  console.log("  GET /scenario/auth-storm     5× JWT failures");
  console.log("\n  GET /health\n");
});

process.on("SIGTERM", async () => {
  await reliability.flush();
  process.exit(0);
});
