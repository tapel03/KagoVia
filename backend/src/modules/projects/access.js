import { notFound, forbidden } from '../../lib/errors.js';

// Object-level authorization (OWASP API1). Access comes from ownership or explicit membership, never from
// knowing an id. Anyone else gets 404 so ids cannot be probed.
export async function loadProject(db, projectId, user, { write = false, ownerOnly = false, forUpdate = false } = {}) {
  const { rows } = await db.query(
    `SELECT p.*, m.role AS member_role
       FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.id = $1 AND p.deleted_at IS NULL AND (p.owner_id = $2 OR m.user_id IS NOT NULL)
      ${forUpdate ? 'FOR UPDATE OF p' : ''}`,
    [projectId, user.id],
  );
  const project = rows[0];
  if (!project) throw notFound('Project not found');
  const isOwner = project.owner_id === user.id;
  if (ownerOnly && !isOwner) throw forbidden('Only the project owner can do this');
  if (write && !isOwner && project.member_role !== 'editor') throw forbidden('You have view-only access to this project');
  return { project, isOwner };
}

export const UUID = { type: 'string', format: 'uuid' };
export const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: UUID } };
