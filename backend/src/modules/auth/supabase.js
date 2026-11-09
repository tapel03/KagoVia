// Thin client for the Supabase Auth (GoTrue) REST API. KagoBuild never sees or stores password hashes.
import { HttpError, unavailable } from '../../lib/errors.js';

export function createSupabaseAuth({ url, anonKey, emailRedirectTo }) {
  const base = url ? `${url}/auth/v1` : '';

  async function call(pathname, { method = 'POST', body, accessToken } = {}) {
    if (!base || !anonKey) throw unavailable('auth_not_configured', 'Sign-in is not configured');
    let res;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          apikey: anonKey,
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unavailable('auth_unavailable', 'Sign-in service is unavailable, try again shortly');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500) throw unavailable('auth_unavailable', 'Sign-in service is unavailable, try again shortly');
    if (!res.ok) {
      // Map provider errors to neutral messages; do not reveal whether an email exists.
      if (res.status === 429) throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later');
      if (pathname.startsWith('/token')) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
      if (pathname === '/signup' && /password/i.test(data.msg || data.error_description || '')) {
        throw new HttpError(400, 'weak_password', 'Password does not meet the requirements');
      }
      throw new HttpError(400, 'auth_request_rejected', 'The request could not be completed');
    }
    return data;
  }

  return {
    signUp: (email, password) =>
      call(`/signup${emailRedirectTo ? `?redirect_to=${encodeURIComponent(emailRedirectTo)}` : ''}`, { body: { email, password } }),
    signIn: (email, password) => call('/token?grant_type=password', { body: { email, password } }),
    refresh: (refreshToken) => call('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }),
    recover: (email) => call(`/recover${emailRedirectTo ? `?redirect_to=${encodeURIComponent(emailRedirectTo)}` : ''}`, { body: { email } }),
    logout: (accessToken) => call('/logout', { accessToken }),
  };
}
