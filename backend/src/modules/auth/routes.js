import { ACCESS_COOKIE, REFRESH_COOKIE, isAdmin } from '../../plugins/auth.js';
import { unauthorized, HttpError } from '../../lib/errors.js';
import { DISPOSABLE_EMAIL_MESSAGE } from '../../lib/disposable-email.js';

// Credential routes: 5 per minute per IP, and they FAIL CLOSED if the rate limiter (Redis) is down.
const strict = { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } };
const credentials = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 320 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
  },
};
const noStore = (reply) => reply.header('cache-control', 'no-store');

export default async function authRoutes(app) {
  const { config } = app;
  const cookieBase = { httpOnly: true, secure: config.isProd, sameSite: 'lax' };

  function setSession(reply, session) {
    if (!session?.access_token) return false;
    reply.setCookie(ACCESS_COOKIE, session.access_token, {
      ...cookieBase, path: '/', maxAge: Math.max(60, Math.min(Number(session.expires_in) || 3600, 3600)),
    });
    if (session.refresh_token) {
      reply.setCookie(REFRESH_COOKIE, session.refresh_token, { ...cookieBase, path: '/api/v1/auth', maxAge: 30 * 24 * 3600 });
    }
    return true;
  }
  function clearSession(reply) {
    reply.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/api/v1/auth' });
  }

  // Throwaway addresses are refused before anything is sent to Supabase.
  function refuseDisposable(email, request) {
    if (!app.disposableEmail.isDisposableEmail(email)) return;
    request.log.info({ domain: email.slice(email.lastIndexOf('@') + 1) }, 'disposable email refused');
    throw new HttpError(400, 'disposable_email', DISPOSABLE_EMAIL_MESSAGE);
  }

  app.post('/register', { config: strict, schema: { body: credentials } }, async (request, reply) => {
    noStore(reply);
    const email = request.body.email.toLowerCase();
    refuseDisposable(email, request);
    const result = await app.supabase.signUp(email, request.body.password);
    // With email confirmation on (recommended), Supabase returns no session until the email is verified.
    const signedIn = setSession(reply, result.session ?? (result.access_token ? result : null));
    return reply.status(201).send({ status: signedIn ? 'signed_in' : 'confirmation_required' });
  });

  app.post('/login', { config: strict, schema: { body: credentials } }, async (request, reply) => {
    noStore(reply);
    refuseDisposable(request.body.email.toLowerCase(), request);
    const session = await app.supabase.signIn(request.body.email.toLowerCase(), request.body.password);
    setSession(reply, session);
    const payload = await app.verifyAccessToken(session.access_token);
    const user = await app.loadUser(payload);
    return { user: publicUser(user) };
  });

  app.post('/forgot', {
    config: strict,
    schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', format: 'email', maxLength: 320 } } } },
  }, async (request, reply) => {
    noStore(reply);
    refuseDisposable(request.body.email.toLowerCase(), request);
    // Same answer whether or not the account exists.
    try {
      await app.supabase.recover(request.body.email.toLowerCase());
    } catch (err) {
      if (err.statusCode >= 500) throw err;
    }
    return reply.status(202).send({ status: 'if_account_exists_email_sent' });
  });

  app.post('/refresh', { config: strict }, async (request, reply) => {
    noStore(reply);
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh session');
    let session;
    try {
      session = await app.supabase.refresh(token);
    } catch (err) {
      if (err.statusCode >= 500) throw err;
      clearSession(reply);
      throw unauthorized('Session expired, sign in again');
    }
    setSession(reply, session);
    return { status: 'refreshed' };
  });

  app.post('/logout', async (request, reply) => {
    noStore(reply);
    const token = request.cookies[ACCESS_COOKIE];
    clearSession(reply);
    // Best effort upstream revocation; short access-token life limits risk if it fails.
    if (token) await app.supabase.logout(token).catch((err) => request.log.warn({ code: err.code }, 'upstream logout failed'));
    return { status: 'signed_out' };
  });

  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    noStore(reply);
    return { user: publicUser(request.user) };
  });
}

export function publicUser(user) {
  return { id: user.id, email: user.email, roles: [...user.roles].sort(), isAdmin: isAdmin(user), mfa: user.aal === 'aal2' };
}
