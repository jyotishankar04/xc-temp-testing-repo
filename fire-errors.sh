#!/usr/bin/env bash
# Fire all test errors at both apps (single captures — exercises SDK integration)
# For case grouping / severity escalation tests, use scenario-runner.ts instead.

NODE_PORT=${1:-3001}
PYTHON_PORT=${2:-3002}

NODE="http://localhost:$NODE_PORT"
PYTHON="http://localhost:$PYTHON_PORT"

hit() {
  local url="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null) || code="ERR"
  printf "  %-45s %s\n" "$url" "$code"
}

echo "=== Node.js errors (port $NODE_PORT) ==="
for path in \
  /error/db-pool \
  /error/payment-timeout \
  /error/redis-wrongtype \
  /error/jwt-expired \
  /error/s3-denied \
  /error/config-missing \
  /error/heap-oom \
  /error/grpc-unavailable \
  /error/uncaught-db; do
  hit "$NODE$path"
  sleep 0.3
done

echo ""
echo "=== Node.js scenario endpoints ==="
hit "$NODE/scenario/db-cascade"
sleep 0.3
hit "$NODE/scenario/auth-storm"

echo ""
echo "=== Python errors (port $PYTHON_PORT) ==="
for path in \
  /error/sqlalchemy-pool \
  /error/celery-timeout \
  /error/stripe-ratelimit \
  /error/pydantic-validation \
  /error/disk-full \
  /error/s3-denied \
  /error/redis-down \
  /error/uncaught-db; do
  hit "$PYTHON$path"
  sleep 0.3
done

echo ""
echo "=== Python scenario endpoints ==="
hit "$PYTHON/scenario/infra-cascade"
sleep 0.3
hit "$PYTHON/scenario/data-pipeline-crash"

echo ""
echo "Done — check your XecureCode dashboard for captured failures."
echo ""
echo "To test case grouping + severity escalation, run:"
echo "  XC_API_KEY=... XC_SERVICE_ID=... npx ts-node scenario-runner.ts severity-climb db-pool"
