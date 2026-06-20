import os
import uuid
from reliability import ReliabilityClient, ReliabilityConfig

api_key = os.environ.get("XC_API_KEY")
service_id = os.environ.get("XC_SERVICE_ID")
endpoint = os.environ.get("XC_ENDPOINT", "http://localhost:4000/api/v1/ingest")

if not api_key or not service_id:
    raise RuntimeError("XC_API_KEY and XC_SERVICE_ID are required")

client = ReliabilityClient(
    ReliabilityConfig(
        api_key=api_key,
        service_id=service_id,
        mode="production",
        endpoint=endpoint,
        version="1.2.3",
        release="xc-temp-release",
        commit_hash="abc123def456",
        branch="main",
        build_id="build-002",
        deployment_id=str(uuid.uuid4()),
    )
)

client.capture(RuntimeError("Python SDK temp test error"))
client.capture(RuntimeError("Python SDK temp test error #2"))
client.capture(RuntimeError("Python SDK temp test error #3"))

import asyncio
asyncio.run(client.flush())
client.shutdown()
print("python-sdk:sent")
