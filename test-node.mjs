import crypto from "node:crypto";
import { ReliabilityClient } from "@xecurecode/reliability-sdk";

const apiKey = process.env.XC_API_KEY;
const serviceId = process.env.XC_SERVICE_ID;
const endpoint = process.env.XC_ENDPOINT || "http://localhost:4000/api/v1/ingest";

if (!apiKey || !serviceId) {
  throw new Error("XC_API_KEY and XC_SERVICE_ID are required");
}

const client = new ReliabilityClient({
  apiKey,
  service_id: serviceId,
  mode: "production",
  endpoint,
  version: "1.2.3",
  release: "xc-temp-release",
  commitHash: "abc123def456",
  branch: "main",
  buildId: "build-001",
  deploymentId: crypto.randomUUID(),
});

client.capture(new Error("Node SDK temp test error"));
client.capture(new Error("Node SDK temp test error #2"));
client.capture(new Error("Node SDK temp test error #3"));

await new Promise((resolve) => setTimeout(resolve, 7000));
client.shutdown();

console.log("node-sdk:sent");
