import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { unauthorized, forbidden, unavailable, HttpError } from '../lib/errors.js';
import { createDisposableChecker, DISPOSABLE_EMAIL_MESSAGE } from '../lib/disposable-email.js';

export const ACCESS_COOKIE = 'kb_at';
export const REFRESH_COOKIE = 'kb_rt';
const ADMIN_ROLES = ['admin', 'super_admin'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readToken(request) {
  const header = request.headers.authorization;
  if (header && header.startsWith('Bearer ')) return { token: header.slice(7).trim(), via: 'bearer' };
  const cookie = request.cookies?.[ACCESS_COOKIE];
  if (cookie) return { token: cookie, via: 'cookie' };
  return null;
}

async function authPlugin(app, { config, db, jwks }) {
  const disposable = createDisposableChecker(config.disposableEmail);
  app.decorate('disposableEmail', disposable);

  // jwks may be injected (tests); otherwise fetched from Supabase and cached by jose.
  const keySet = jwks || (config.supabase.jwksUrl
    ? createRemoteJWKSet(new URL(config.supabase.jwksUrl), { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30_000, timeoutDuration: 5000 })
    : null);

  async function verify(token) {
    if (!keySet) throw unavailable('auth_not_configured', 'Sign-in is not configured');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: config.supabase.issuer || undefined,
        audience: config.supabase.audience,
        algorithms: ['RS256', 'ES256'], // asymmetric only; legacy HS256 projects are refused
        clockTolerance: 5,
      }));
    } catch (err) {
      // jose errors have codes like ERR_JWT_EXPIRED / ERR_JWS_SIGNATURE_VERIFICATION_FAILED (-> 401).
      // A JWKS timeout or a network failure fetching keys is the provider being down (-> 503).
      const code = String(err?.code || '');
      if (code === 'ERR_JWKS_TIMEOUT' || !code.startsWith('ERR_J')) {
        throw unavailable('auth_unavailable', 'Sign-in service is unavailable, try again shortly');
      }
      throw unauthorized('Session expired or invalid');
    }
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) throw unauthorized('Invalid token subject');
    return payload;
  }

  // Loads (and on first sight creates) the local user row and roles. Roles come only from the database.
  async function loadUser(payload) {
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase().slice(0, 320) : null;
    // Also catches accounts made directly at Supabase or via social sign-in, bypassing /auth/register.
    if (email && disposable.isDisposableEmail(email)) {
      throw new HttpError(403, 'disposable_email', DISPOSABLE_EMAIL_MESSAGE);
    }
    // Touch last_seen_at at most every 5 minutes to keep writes low.
    await db.query(
      `INSERT INTO app_users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), email = COALESCE(EXCLUDED.email, app_users.email)
         WHERE app_users.last_seen_at < now() - interval '5 minutes'`,
      [payload.sub, email],
    );
    const status = await db.query(
      `SELECT u.deleted_at, COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
         FROM app_users u LEFT JOIN user_roles r ON r.user_id = u.id
        WHERE u.id = $1 GROUP BY u.id`,
      [payload.sub],
    );
    const row = status.rows[0];
    if (!row || row.deleted_at) throw unauthorized('Account is not active');
    const roles = new Set(['customer', ...row.roles]);
    return { id: payload.sub, email, roles, aal: payload.aal || 'aal1' };
  }

  app.decorateRequest('user', null);
  app.decorateRequest('authVia', null);
  app.decorateRequest('tokenExp', null);

  async function authenticate(request) {
    const found = readToken(request);
    if (!found) throw unauthorized();
    const payload = await verify(found.token);
    request.user = await loadUser(payload);
    request.authVia = found.via;
    request.tokenExp = typeof payload.exp === 'number' ? payload.exp : null;
  }

  // Optional auth: sets request.user when a valid token is present, otherwise continues anonymously.
  async function optionalAuth(request) {
    const found = readToken(request);
    if (!found) return;
    try {
      await authenticate(request);
    } catch (err) {
      if (err.statusCode === 503) throw err;
    }
  }

  const requireRole = (...roles) => async (request) => {
    if (!request.user) await authenticate(request);
    if (!roles.some((r) => request.user.roles.has(r))) throw forbidden('Your account does not have access to this');
  };

  app.decorate('verifyAccessToken', verify);
  app.decorate('loadUser', loadUser);
  app.decorate('authenticate', authenticate);
  app.decorate('optionalAuth', optionalAuth);
  app.decorate('requireRole', requireRole);
  app.decorate('requireAdmin', requireRole(...ADMIN_ROLES));
}

export const isAdmin = (user) => !!user && ADMIN_ROLES.some((r) => user.roles.has(r));
export const isSupport = (user) => !!user && (user.roles.has('support') || isAdmin(user));

export default fp(authPlugin, { name: 'auth' });
