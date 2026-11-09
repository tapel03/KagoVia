import pg from 'pg';

// bigint (int8) columns come back as strings by default. Money and counters fit safely in a JS number
// below 2^53, so parse them, but refuse values that would lose precision.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${v}`);
  return n;
});
// numeric stays a string (quantities like 12.345); convert explicitly where needed.

export function createPool(config, log) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    // A transaction left open (e.g. waiting on a network call) is killed instead of holding locks.
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'kagobuild',
  });
  pool.on('error', (err) => log?.error({ err }, 'idle postgres client error'));
  return pool;
}

// Runs fn inside a transaction. Retries on serialization failure / deadlock (40001, 40P01).
export async function tx(pool, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err.code === '40001' || err.code === '40P01') && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
