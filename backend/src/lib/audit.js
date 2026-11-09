// Append-only audit trail for admin and security-relevant actions. Never store secrets or tokens here.
export async function audit(db, { actorId = null, action, target = null, ip = null, details = {} }) {
  await db.query(
    'INSERT INTO audit_log (actor_id, action, target, ip, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, target, ip, details],
  );
}
