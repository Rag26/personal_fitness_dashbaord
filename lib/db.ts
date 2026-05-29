import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

/**
 * Supabase's session-mode pooler (port 5432 on *.pooler.supabase.com) pins one
 * Postgres backend per client connection for the whole session. On Vercel,
 * frozen lambdas keep those connections open — the pool's idle timer can't fire
 * while a function is frozen — so backends accumulate across instances until the
 * pooler's 15-client ceiling is hit (EMAXCONNSESSION). The transaction-mode
 * pooler (port 6543) multiplexes: a backend is borrowed only for the duration of
 * a statement/transaction and returned afterward, so idle lambdas hold no
 * backend. It's the configuration Supabase recommends for serverless, so upgrade
 * a session-mode URL to it transparently. Only the runtime pool is rewritten —
 * migrations go through prisma.config.ts and keep session mode for DDL.
 */
function toServerlessConnectionString(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "5432") {
      u.port = "6543";
      return u.toString();
    }
  } catch {
    // Not a parseable URL — leave it untouched and let Pool surface the error.
  }
  return raw;
}

function getPool() {
  const rawConnectionString = process.env.DATABASE_URL;
  if (!rawConnectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your environment (e.g. .env.local).",
    );
  }
  if (
    rawConnectionString.startsWith("http://") ||
    rawConnectionString.startsWith("https://")
  ) {
    throw new Error(
      'DATABASE_URL must be a Postgres connection string (starts with "postgres://" or "postgresql://"), not a Supabase project URL.',
    );
  }
  const connectionString = toServerlessConnectionString(rawConnectionString);

  if (process.env.NODE_ENV === "production") {
    // Belt-and-suspenders alongside the transaction-mode upgrade above:
    // serverless spins up many lambda instances that all share the pooler's 15
    // backends, so cap each instance to a single connection. Queries within a
    // request serialize over it, which is fine for our fast indexed reads. With
    // the transaction pooler this can safely be raised to restore per-request
    // concurrency on heavy pages like /train.
    return new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10_000,
    });
  }

  if (!globalForPrisma.prismaPool) {
    globalForPrisma.prismaPool = new Pool({ connectionString });
  }
  return globalForPrisma.prismaPool;
}

/**
 * If this model delegate is missing, the process is holding a pre-generate
 * client. Bump this to the *latest* added model whenever the schema gains a
 * new one so dev HMR picks up the regenerated client without a manual restart.
 */
const PRISMA_SCHEMA_MARKER = "foodLibraryItem" as const;

function discardStalePrismaClient(client: PrismaClient) {
  void client.$disconnect().catch(() => {});
}

/**
 * Lazy Prisma client initializer.
 *
 * Important: Next.js may import route modules during build. If we eagerly create
 * a DB connection at import-time, builds can fail when DATABASE_URL isn't set.
 * This function defers initialization until runtime when the DB is actually used.
 *
 * In development, `globalThis` keeps the same Prisma instance across HMR while
 * `npx prisma generate` updates `@prisma/client`. Drop the cache when delegates
 * are missing so new code (e.g. new models) works without a manual dev restart.
 */
export function prisma() {
  const cached = globalForPrisma.prisma;
  if (cached && !(PRISMA_SCHEMA_MARKER in cached)) {
    discardStalePrismaClient(cached);
    globalForPrisma.prisma = undefined;
  }

  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const client = new PrismaClient({
    adapter: new PrismaPg(getPool()),
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

  globalForPrisma.prisma = client;
  return client;
}

