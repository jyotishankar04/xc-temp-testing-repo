import fs from "node:fs";
import { PrismaPg } from "file:///home/devsuvam/Desktop/code-xc-backend/node_modules/@prisma/adapter-pg/dist/index.mjs";
import { PrismaClient } from "file:///home/devsuvam/Desktop/code-xc-backend/src/generated/prisma/client.ts";

const serviceId = process.env.XC_SERVICE_ID;
if (!serviceId) throw new Error("XC_SERVICE_ID is required");

const envText = fs.readFileSync("/home/devsuvam/Desktop/code-xc-backend/.env.dev", "utf8");
const databaseUrl = envText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .find((line) => line.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length)
  .replace(/^['\"]|['\"]$/g, "");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const count = await prisma.failureEvent.count({ where: { serviceId } });
const recent = await prisma.failureEvent.findMany({
  where: { serviceId },
  orderBy: { timestamp: "desc" },
  take: 5,
  select: { id: true, errorMessage: true, fingerprint: true, occurrenceCount: true, timestamp: true },
});

console.log(JSON.stringify({ count, recent }, null, 2));
await prisma.$disconnect();
