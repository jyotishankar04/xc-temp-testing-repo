import crypto from "node:crypto";
import fs from "node:fs";
import { PrismaPg } from "file:///home/devsuvam/Desktop/code-xc-backend/node_modules/@prisma/adapter-pg/dist/index.mjs";
import { PrismaClient, $Enums } from "file:///home/devsuvam/Desktop/code-xc-backend/src/generated/prisma/client.ts";

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

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const org = await prisma.organization.upsert({
  where: { slug: "xc-sdk-temp" },
  update: {
    name: "XC SDK Temp",
    status: $Enums.OrgStatus.ACTIVE,
  },
  create: {
    name: "XC SDK Temp",
    slug: "xc-sdk-temp",
    status: $Enums.OrgStatus.ACTIVE,
  },
});

const currentService =
  (await prisma.service.findFirst({
    where: {
      orgId: org.id,
      name: "xc-temp-service",
      env: $Enums.Environment.PRODUCTION,
    },
  })) ??
  (await prisma.service.create({
    data: {
      orgId: org.id,
      name: "xc-temp-service",
      env: $Enums.Environment.PRODUCTION,
      description: "Temporary service for SDK testing",
    },
  }));

const apiKey = `xc-temp-${crypto.randomBytes(24).toString("hex")}`;
const valueHash = crypto.createHash("sha256").update(apiKey).digest("hex");

await prisma.apiKey.create({
  data: {
    orgId: org.id,
    serviceId: currentService.id,
    name: "xc-temp-key",
    valueHash,
  },
});

console.log(JSON.stringify({ orgId: org.id, serviceId: currentService.id, apiKey }, null, 2));
await prisma.$disconnect();
