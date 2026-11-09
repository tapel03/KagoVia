import { BRIEF_JSON_SCHEMA, normaliseBrief } from '../../domain/plan.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { loadProject, idParams } from './access.js';

const projectOut = {
  type: 'object',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, regionCode: { type: 'string' }, status: { type: 'string' },
    brief: { type: 'object', additionalProperties: true }, budgetCents: { type: ['integer', 'null'] },
    version: { type: 'integer' }, role: { type: 'string' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' },
  },
};
const toOut = (p, role) => ({
  id: p.id, name: p.name, regionCode: p.region_code, status: p.status, brief: p.brief, budgetCents: p.budget_cents,
  version: p.version, role, createdAt: p.created_at.toISOString(), updatedAt: p.updated_at.toISOString(),
});
const roleOf = (p, userId) => (p.owner_id === userId ? 'owner' : p.member_role);

const editable = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  regionCode: { type: 'string', pattern: '^[A-Z]{2,3}$' },
  brief: BRIEF_JSON_SCHEMA,
  budgetCents: { type: ['integer', 'null'], minimum: 0, maximum: 100_000_000_000 },
};

// Cursor = base64url("<updated_at ISO>|<id>") for stable keyset pagination.
const encodeCursor = (p) => Buffer.from(`${p.updated_at.toISOString()}|${p.id}`).toString('base64url');
function decodeCursor(c) {
  const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('invalid_cursor', 'Invalid cursor');
  return [ts, id];
}

export default async function projectRoutes(app) {
  const { db } = app;
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'private, no-store'); });

  app.get('/projects', {
    preHandler: app.authenticate,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: 'string', maxLength: 200 } },
      },
      response: { 200: { type: 'object', properties: { items: { type: 'array', items: projectOut }, nextCursor: { type: ['string', 'null'] } } } },
    },
  }, async (request) => {
    const { limit, cursor } = request.query;
    const params = [request.user.id, limit + 1];
    let where = '';
    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      params.push(ts, id);
      where = 'AND (p.updated_at, p.id) < ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await db.query(
      `SELECT p.*, m.role AS member_role FROM projects p
         LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
        WHERE p.deleted_at IS NULL AND (p.owner_id = $1 OR m.user_id IS NOT NULL) ${where}
        ORDER BY p.updated_at DESC, p.id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((p) => toOut(p, roleOf(p, request.user.id))),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  });

  app.post('/projects', {
    preHandler: app.authenticate,
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['name', 'regionCode'], properties: editable },
      response: { 201: projectOut },
    },
  }, async (request, reply) => {
    const { name, regionCode, brief, budgetCents = null } = request.body;
    const region = await db.query('SELECT 1 FROM regions WHERE code = $1 AND is_active', [regionCode]);
    if (!region.rowCount) throw badRequest('unknown_region', 'Unknown or inactive region');
    const { rows } = await db.query(
      `INSERT INTO projects (owner_id, name, region_code, brief, budget_cents) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [request.user.id, name.trim(), regionCode, normaliseBrief(brief), budgetCents],
    );
    return reply.status(201).send(toOut(rows[0], 'owner'));
  });

  app.get('/projects/:id', { preHandler: app.authenticate, schema: { params: idParams, response: { 200: projectOut } } }, async (request) => {
    const { project } = await loadProject(db, request.params.id, request.user);
    return toOut(project, roleOf(project, request.user.id));
  });

  app.patch('/projects/:id', {
    preHandler: app.authenticate,
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['version'], minProperties: 2,
        properties: { version: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['draft', 'active', 'approved', 'archived'] }, ...editable },
      },
      response: { 200: projectOut },
    },
  }, async (request) => {
    const { project } = await loadProject(db, request.params.id, request.user, { write: true });
    const b = request.body;
    if (b.regionCode) {
      const region = await db.query('SELECT 1 FROM regions WHERE code = $1 AND is_active', [b.regionCode]);
      if (!region.rowCount) throw badRequest('unknown_region', 'Unknown or inactive region');
    }
    // Optimistic concurrency: the update only applies if nobody changed the project since the client read it.
    const { rows } = await db.query(
      `UPDATE projects SET
          name = COALESCE($3, name), region_code = COALESCE($4, region_code), status = COALESCE($5, status),
          brief = COALESCE($6, brief),
          budget_cents = CASE WHEN $7::boolean THEN $8::bigint ELSE budget_cents END,
          version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING *`,
      [project.id, b.version, b.name?.trim() ?? null, b.regionCode ?? null, b.status ?? null,
        b.brief ? normaliseBrief(b.brief) : null, 'budgetCents' in b, b.budgetCents ?? null],
    );
    if (!rows[0]) throw conflict('version_conflict', 'This project was changed by someone else. Reload and try again.', { currentVersion: project.version });
    return toOut({ ...rows[0], member_role: project.member_role }, roleOf({ ...rows[0], member_role: project.member_role }, request.user.id));
  });

  app.delete('/projects/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request, reply) => {
    const { project } = await loadProject(db, request.params.id, request.user, { ownerOnly: true });
    await db.query('UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1', [project.id]);
    return reply.status(204).send();
  });
}
