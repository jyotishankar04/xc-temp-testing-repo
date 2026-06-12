# XecureCode SDK Test Apps

Two test applications for verifying the reliability engine end-to-end.

## Prerequisites

1. Backend running at `http://localhost:4000`
2. A service created in the XecureCode dashboard
3. An API key generated for that service (Services → your service → Settings → API Keys)

Both apps fail fast when `XC_API_KEY` or `XC_SERVICE_ID` are missing. Keep local
`.env` files out of source control.

## Node.js App (port 3001)

```bash
cd node-app
cp .env.example .env
# Edit .env — set XC_API_KEY and XC_SERVICE_ID
XC_API_KEY=your_key XC_SERVICE_ID=your_svc npx ts-node src/app.ts
```

## Python App (port 3002)

```bash
cd python-app
# Activate the pre-created virtualenv
source venv/bin/activate
XC_API_KEY=your_key XC_SERVICE_ID=your_svc python app.py
```

## Direct backend scenarios

Use the root `scenario-runner.ts` when you want to bypass SDK deduplication and
send payloads directly to the ingest endpoint. This is useful for verifying case
grouping, severity escalation, and RCA context quality.

## Fire test errors

Once both apps are running, use the fire-errors.sh script:

```bash
bash fire-errors.sh your_node_port your_python_port
# e.g.: bash fire-errors.sh 3001 3002
```

Or hit individual endpoints:

| App    | Endpoint              | Error type              |
|--------|-----------------------|-------------------------|
| Node   | /error/runtime        | Null reference          |
| Node   | /error/async          | Async rejection         |
| Node   | /error/database       | DB connection refused   |
| Node   | /error/network        | Network timeout         |
| Node   | /error/validation     | Validation failure      |
| Node   | /error/burst          | 5 errors at once        |
| Python | /error/runtime        | AttributeError          |
| Python | /error/type           | TypeError               |
| Python | /error/database       | DB connection refused   |
| Python | /error/network        | Network timeout         |
| Python | /error/validation     | Validation failure      |
| Python | /error/zero-division  | ZeroDivisionError       |
| Python | /error/burst          | 5 errors at once        |
