// Public material catalogue with the lowest current price per material in a region.
// Cache-aside in Redis for 45 s (jittered); falls back to PostgreSQL if Redis is down. Not a binding quote.

const CACHE_TTL_S = 45;
export const catalogueKey = (region, category, q, limit) => `kb:v1:materials:${region}:${category || '*'}:${q || '*'}:${limit}`;

export default async function materialRoutes(app) {
  const { db, redis } = app;

  app.get('/materials', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['region'],
        properties: {
          region: { type: 'string', pattern: '^[A-Z]{2,3}$' },
          category: { type: 'string', pattern: '^[a-z_]{2,30}$' },
          q: { type: 'string', minLength: 2, maxLength: 60 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const { region, category, q, limit } = request.query;
    const key = catalogueKey(region, category, q?.toLowerCase(), limit);
    reply.header('cache-control', 'public, max-age=20');

    const cached = await redis.get(key).catch(() => null);
    if (cached) return reply.header('x-cache', 'hit').type('application/json').send(cached);

    const { rows } = await db.query(
      `SELECT m.code, m.name, m.category, m.unit,
              best.price_cents, best.observed_at, s.name AS supplier
         FROM materials m
         LEFT JOIN LATERAL (
           SELECT cp.price_cents, cp.observed_at, cp.supplier_id FROM current_prices cp
            WHERE cp.material_id = m.id AND cp.region_code = $1
            ORDER BY cp.price_cents ASC, cp.observed_at DESC LIMIT 1) best ON true
         LEFT JOIN suppliers s ON s.id = best.supplier_id
        WHERE m.is_active
          AND ($2::text IS NULL OR m.category = $2)
          AND ($3::text IS NULL OR m.name ILIKE '%' || $3 || '%')
        ORDER BY m.category, m.name
        LIMIT $4`,
      [region, category ?? null, q ? q.replace(/[%_\\]/g, (c) => `\\${c}`) : null, limit],
    );
    const body = JSON.stringify({
      region,
      items: rows.map((r) => ({
        code: r.code, name: r.name, category: r.category, unit: r.unit,
        lowestPriceCents: r.price_cents ?? null, supplier: r.supplier ?? null,
        priceObservedAt: r.observed_at ? r.observed_at.toISOString() : null,
      })),
      note: 'Indicative prices, not a quotation.',
    });
    const ttl = CACHE_TTL_S + Math.floor(Math.random() * 10); // jitter avoids synchronized expiry
    redis.set(key, body, 'EX', ttl).catch(() => {});
    return reply.header('x-cache', 'miss').type('application/json').send(body);
  });
}

// Called after admin price changes. SCAN (not KEYS) so Redis is not blocked.
export async function invalidateCatalogue(redis, region) {
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `kb:v1:materials:${region}:*`, 'COUNT', 200);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } catch {
    // TTL (45 s) bounds staleness if Redis is unavailable.
  }
}
