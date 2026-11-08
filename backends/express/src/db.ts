import pg from "pg";
import { config } from "./config";

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ ...config.db, max: 20 });

export type Db = pg.PoolClient;

async function transaction<T>(setup: string, params: unknown[], fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (setup) await client.query(setup, params);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Plain transaction, for the tables without row-level security (orgs, users). */
export const withTransaction = <T>(fn: (db: Db) => Promise<T>) => transaction("", [], fn);

/** Transaction scoped to one org: row-level security hides every other org's rows. */
export const withOrg = <T>(orgId: string, fn: (db: Db) => Promise<T>) =>
  transaction("SELECT set_config('app.org_id', $1, true)", [orgId], fn);

/** Transaction for background jobs that work across all orgs. */
export const withSystem = <T>(fn: (db: Db) => Promise<T>) =>
  transaction("SELECT set_config('app.bypass_rls', 'on', true)", [], fn);

export const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
