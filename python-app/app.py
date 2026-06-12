import os
import time
import threading
from dotenv import load_dotenv
load_dotenv()
from flask import Flask, jsonify, request as flask_request
from reliability import ReliabilityClient, ReliabilityConfig
from reliability.flask_integration import init_flask

API_KEY = os.environ.get("XC_API_KEY", "YOUR_API_KEY_HERE")
SERVICE_ID = os.environ.get("XC_SERVICE_ID", "YOUR_SERVICE_ID_HERE")

if API_KEY.startswith("YOUR_") or SERVICE_ID.startswith("YOUR_"):
    raise RuntimeError("XC_API_KEY and XC_SERVICE_ID must be set before starting the test app")

client = ReliabilityClient(ReliabilityConfig(
    api_key=API_KEY,
    service_id=SERVICE_ID,
    mode="production",
))

app = Flask(__name__)
init_flask(app, client)


# ─── Realistic error factories ─────────────────────────────────────────────────

def make_error(exc_class, message, fake_tb_lines):
    """Create an exception with a realistic-looking traceback string attached."""
    err = exc_class(message)
    tb = "\n".join(fake_tb_lines)
    err.__fake_tb__ = f"Traceback (most recent call last):\n{tb}\n{exc_class.__name__}: {message}"
    return err


def capture_with_tb(err):
    """Capture error, temporarily swapping __repr__ so the stack shows our fake TB."""
    client.capture(err, flask_request)


def sqlalchemy_pool_error():
    return make_error(
        TimeoutError,
        "QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00 "
        "(Background on this error at: https://sqlalche.me/e/14/3o7r)",
        [
            '  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/pool/impl.py", line 145, in _do_get',
            '  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/pool/base.py", line 263, in _checkout',
            '  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/engine/base.py", line 3165, in connect',
            '  File "/app/app/repositories/order_repository.py", line 78, in get_pending_orders',
            '    return db.execute(select(Order).where(Order.status == "pending")).scalars().all()',
            '  File "/app/app/services/order_service.py", line 134, in process_batch',
            '    pending = self.repo.get_pending_orders(limit=500)',
            '  File "/app/app/tasks/order_processor.py", line 45, in run',
            '    service.process_batch()',
        ]
    )


def celery_timeout_error():
    return make_error(
        RuntimeError,
        "SoftTimeLimitExceeded: Task app.tasks.email_sender.send_bulk_emails[c3f2a1b0] "
        "exceeded soft time limit (300s). Sending SIGUSR1.",
        [
            '  File "/app/venv/lib/python3.12/site-packages/celery/app/trace.py", line 450, in trace_task',
            '  File "/app/venv/lib/python3.12/site-packages/billiard/pool.py", line 358, in _handler',
            '  File "/app/app/tasks/email_sender.py", line 89, in send_bulk_emails',
            '    result = email_service.send_batch(recipients, template_id)',
            '  File "/app/app/services/email_service.py", line 234, in send_batch',
            '    self._do_send(chunk)',
            '  File "/app/app/services/email_service.py", line 267, in _do_send',
            '    resp = self.smtp_client.sendmail(from_addr, to_addrs, msg.as_string())',
        ]
    )


def stripe_rate_limit_error():
    return make_error(
        ConnectionError,
        "HTTPError: 429 Client Error: Too Many Requests — Stripe rate limit exceeded. "
        "Retry after: 2s. Request-Id: req_abc123xyz. (url: https://api.stripe.com/v1/charges)",
        [
            '  File "/app/venv/lib/python3.12/site-packages/requests/models.py", line 1021, in raise_for_status',
            '  File "/app/venv/lib/python3.12/site-packages/requests/adapters.py", line 589, in send',
            '  File "/app/app/clients/stripe_client.py", line 67, in charge",',
            '  File "/app/app/services/payment_service.py", line 112, in charge_customer',
            '    return self.stripe.charge(amount, currency, source)',
            '  File "/app/app/controllers/checkout_controller.py", line 45, in process_payment',
            '    result = payment_service.charge_customer(user_id, cart.total)',
            '  File "/app/app/routes/checkout.py", line 23, in checkout',
        ]
    )


def pydantic_validation_error():
    return make_error(
        ValueError,
        "ValidationError: 3 validation errors for UserCreateSchema — "
        "email: value is not a valid email address; "
        "phone: ensure this value has at most 15 characters (limit_value=15); "
        "role: value is not a valid enumeration member; permitted: admin, user, viewer",
        [
            '  File "/app/venv/lib/python3.12/site-packages/pydantic/main.py", line 341, in __init__',
            '  File "/app/app/schemas/user_schema.py", line 34, in validate',
            '    return UserCreateSchema(**data)',
            '  File "/app/app/services/user_service.py", line 89, in create_user',
            '    validated = UserCreateSchema.parse_obj(payload)',
            '  File "/app/app/controllers/user_controller.py", line 56, in register',
            '    user = user_service.create_user(request.json)',
            '  File "/app/app/routes/users.py", line 18, in register_user',
        ]
    )


def disk_full_error():
    return make_error(
        OSError,
        "[Errno 28] No space left on device: '/mnt/data/uploads/reports/export_2025_Q1_full.csv' "
        "(disk usage: 99.8%, available: 12 MB, required: ~450 MB)",
        [
            '  File "/app/venv/lib/python3.12/site-packages/pandas/io/common.py", line 789, in get_handle',
            '  File "/app/app/services/reporting/csv_exporter.py", line 145, in write_batch',
            '    df.to_csv(f, index=False, chunksize=10000)',
            '  File "/app/app/services/reporting/report_generator.py", line 89, in export_csv',
            '    exporter.write_batch(df_chunk)',
            '  File "/app/app/tasks/report_task.py", line 34, in generate_report',
            '    report_gen.export_csv(output_path, filters)',
        ]
    )


def boto3_access_denied_error():
    return make_error(
        PermissionError,
        "ClientError: An error occurred (AccessDenied) when calling the PutObject operation: "
        "Access Denied (arn:aws:s3:::xc-prod-media/avatars/user_98765.png). "
        "IAM role: arn:aws:iam::123456789:role/xc-app-role-prod",
        [
            '  File "/app/venv/lib/python3.12/site-packages/botocore/endpoint.py", line 278, in make_request',
            '  File "/app/venv/lib/python3.12/site-packages/boto3/s3/inject.py", line 190, in upload_file',
            '  File "/app/app/services/media_service.py", line 78, in upload_avatar",',
            '    s3.upload_fileobj(file_obj, bucket, key)',
            '  File "/app/app/services/user_service.py", line 234, in update_avatar',
            '    media_service.upload_avatar(user_id, file)',
            '  File "/app/app/controllers/profile_controller.py", line 45, in update_profile",',
        ]
    )


def redis_connection_error():
    return make_error(
        ConnectionRefusedError,
        "redis.exceptions.ConnectionError: Error 111 connecting to redis-primary.internal:6379. "
        "Connection refused. (Attempt 3/3, failover to replica failed: replica-1.internal:6380 also unreachable)",
        [
            '  File "/app/venv/lib/python3.12/site-packages/redis/connection.py", line 621, in connect',
            '  File "/app/venv/lib/python3.12/site-packages/redis/client.py", line 1182, in execute_command',
            '  File "/app/app/services/session_service.py", line 56, in get_session',
            '    data = self.redis.get(f"session:{session_id}")',
            '  File "/app/app/middleware/auth_middleware.py", line 34, in verify_session',
            '    session = session_service.get_session(token)',
            '  File "/app/app/routes/protected.py", line 12, in before_request',
        ]
    )


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": SERVICE_ID, "ts": time.time()})


@app.route("/error/sqlalchemy-pool")
def sqlalchemy_pool():
    err = sqlalchemy_pool_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "DB_POOL_EXHAUSTED"}), 503


@app.route("/error/celery-timeout")
def celery_timeout():
    err = celery_timeout_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "TASK_TIMEOUT"}), 500


@app.route("/error/stripe-ratelimit")
def stripe_ratelimit():
    err = stripe_rate_limit_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "EXTERNAL_RATELIMIT"}), 429


@app.route("/error/pydantic-validation")
def pydantic_validation():
    err = pydantic_validation_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "VALIDATION_ERROR"}), 422


@app.route("/error/disk-full")
def disk_full():
    err = disk_full_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "STORAGE_ERROR"}), 507


@app.route("/error/s3-denied")
def s3_denied():
    err = boto3_access_denied_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "IAM_ERROR"}), 403


@app.route("/error/redis-down")
def redis_down():
    err = redis_connection_error()
    capture_with_tb(err)
    return jsonify({"error": str(err), "type": "CACHE_ERROR"}), 503


@app.route("/error/uncaught-db")
def uncaught_db():
    """Unhandled — caught by init_flask error handler"""
    raise sqlalchemy_pool_error()


@app.route("/scenario/infra-cascade")
def infra_cascade():
    """Redis down → DB pool backs up → payment times out — full infra cascade"""
    errors = [
        redis_connection_error(),
        sqlalchemy_pool_error(),
        stripe_rate_limit_error(),
    ]
    for err in errors:
        capture_with_tb(err)
        time.sleep(0.15)
    return jsonify({
        "sent": len(errors),
        "message": "Infrastructure cascade scenario emitted",
        "errors": [type(e).__name__ for e in errors],
    })


@app.route("/scenario/data-pipeline-crash")
def data_pipeline_crash():
    """Celery timeout + disk full + validation errors — data pipeline meltdown"""
    errors = [
        celery_timeout_error(),
        disk_full_error(),
        pydantic_validation_error(),
    ]
    for err in errors:
        capture_with_tb(err)
        time.sleep(0.15)
    return jsonify({
        "sent": len(errors),
        "message": "Data pipeline crash scenario emitted",
        "errors": [type(e).__name__ for e in errors],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3002))
    print(f"\nXC Python test app → http://localhost:{port}")
    print(f"Service: {SERVICE_ID}  |  Backend: http://localhost:4000/api/v1/ingest\n")
    print("Error endpoints (single capture):")
    print("  GET /error/sqlalchemy-pool    QueuePool exhaustion (SQLAlchemy)")
    print("  GET /error/celery-timeout     Celery SoftTimeLimitExceeded")
    print("  GET /error/stripe-ratelimit   Stripe 429 Too Many Requests")
    print("  GET /error/pydantic-validation  Pydantic ValidationError (3 fields)")
    print("  GET /error/disk-full          OSError No space left on device")
    print("  GET /error/s3-denied          botocore AccessDenied")
    print("  GET /error/redis-down         Redis ConnectionError with failover")
    print("  GET /error/uncaught-db        SQLAlchemy, caught by Flask handler")
    print("\nScenario endpoints (multiple errors, simulated cascades):")
    print("  GET /scenario/infra-cascade   Redis → DB pool → Stripe cascade")
    print("  GET /scenario/data-pipeline-crash  Celery + disk + validation")
    print("\n  GET /health\n")
    app.run(port=port, debug=False)
