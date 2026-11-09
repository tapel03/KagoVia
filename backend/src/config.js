// Reads configuration from environment variables.
// In production the app refuses to start when a required setting is missing (fail closed).

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer: ${v}`);
  return n;
};
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/+$/, '');

  const config = {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    publicOrigin: env.PUBLIC_ORIGIN || 'http://localhost:3000',
    allowedOrigins: list(env.ALLOWED_ORIGINS || env.PUBLIC_ORIGIN || 'http://localhost:3000'),
    trustedProxyCidrs: list(env.TRUSTED_PROXY_CIDRS),
    serveFrontend: bool(env.SERVE_FRONTEND, !isProd),
    adminRequireMfa: bool(env.ADMIN_REQUIRE_MFA, isProd),
    // Throwaway email blocking. Extra domains to block, and domains to allow if the list is ever wrong.
    disposableEmail: {
      extraDomains: list(env.DISPOSABLE_EMAIL_EXTRA_DOMAINS),
      allowDomains: list(env.DISPOSABLE_EMAIL_ALLOW_DOMAINS),
    },
    priceReviewThresholdBp: int(env.PRICE_REVIEW_THRESHOLD_BP, 1000), // ±10% (TRD §7)

    databaseUrl: env.DATABASE_URL || '',
    dbPoolMax: int(env.DB_POOL_MAX, 12),
    redisUrl: env.REDIS_URL || '',

    supabase: {
      url: supabaseUrl,
      anonKey: env.SUPABASE_ANON_KEY || '',
      jwksUrl: env.SUPABASE_JWKS_URL || (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : ''),
      issuer: env.SUPABASE_JWT_ISSUER || (supabaseUrl ? `${supabaseUrl}/auth/v1` : ''),
      audience: env.SUPABASE_JWT_AUDIENCE || 'authenticated',
      emailRedirectTo: env.AUTH_EMAIL_REDIRECT_URL || '',
    },

    billing: {
      enabled: bool(env.BILLING_ENABLED, false),
      paystackSecretKey: env.PAYSTACK_SECRET_KEY || '',
      paystackBaseUrl: env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
      callbackUrl: env.PAYSTACK_CALLBACK_URL || '',
      currency: 'ZAR',
    },

    ai: {
      enabled: bool(env.AI_ENABLED, true),
      provider: env.AI_PROVIDER || 'template', // 'openai-compatible' | 'template'
      baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      timeoutMs: int(env.AI_TIMEOUT_MS, 30000),
      freeMonthlyGenerations: int(env.AI_FREE_MONTHLY_GENERATIONS, 3),
    },

    chat: {
      maxMessageBytes: int(env.CHAT_MAX_MESSAGE_BYTES, 4096),
      maxSocketsPerUser: int(env.CHAT_MAX_SOCKETS_PER_USER, 5),
      ratePerWindow: int(env.CHAT_RATE_PER_WINDOW, 20),
      rateWindowMs: int(env.CHAT_RATE_WINDOW_MS, 10000),
      accessRecheckMs: int(env.CHAT_ACCESS_RECHECK_MS, 60000),
    },

    workers: {
      outboxPollMs: int(env.OUTBOX_POLL_MS, 1000),
      reconcileEveryMs: int(env.RECONCILE_EVERY_MS, 10 * 60 * 1000),
      reconcilePendingOlderThanMs: int(env.RECONCILE_PENDING_OLDER_THAN_MS, 5 * 60 * 1000),
    },
  };

  validate(config);
  return config;
}

function validate(c) {
  const missing = [];
  if (!c.databaseUrl) missing.push('DATABASE_URL');
  if (!c.redisUrl) missing.push('REDIS_URL');

  if (c.isProd) {
    if (!c.supabase.url) missing.push('SUPABASE_URL');
    if (!c.supabase.anonKey) missing.push('SUPABASE_ANON_KEY');
    if (!c.publicOrigin.startsWith('https://')) missing.push('PUBLIC_ORIGIN (must be https)');
    if (!c.allowedOrigins.length || c.allowedOrigins.some((o) => !o.startsWith('https://'))) {
      missing.push('ALLOWED_ORIGINS (https only)');
    }
    if (!c.trustedProxyCidrs.length) missing.push('TRUSTED_PROXY_CIDRS');
    if (c.billing.enabled && !c.billing.paystackSecretKey) missing.push('PAYSTACK_SECRET_KEY');
    if (c.ai.enabled && c.ai.provider === 'openai-compatible' && (!c.ai.baseUrl || !c.ai.apiKey || !c.ai.model)) {
      missing.push('AI_BASE_URL / AI_API_KEY / AI_MODEL');
    }
  }
  if (c.ai.baseUrl && !/^https?:\/\//.test(c.ai.baseUrl)) missing.push('AI_BASE_URL (must be a URL)');
  if (missing.length) {
    throw new Error(`Configuration incomplete, refusing to start: ${missing.join(', ')}`);
  }
}
