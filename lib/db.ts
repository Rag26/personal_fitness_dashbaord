import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your environment (e.g. .env.local).",
    );
  }
  if (
    connectionString.startsWith("http://") ||
    connectionString.startsWith("https://")
  ) {
    throw new Error(
      'DATABASE_URL must be a Postgres connection string (starts with "postgres://" or "postgresql://"), not a Supabase project URL.',
    );
  }

  if (process.env.NODE_ENV === "production") {
    return new Pool({ connectionString });
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

