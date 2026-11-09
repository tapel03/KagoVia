import { randomUUID } from 'node:crypto';
import { badRequest, forbidden } from '../../lib/errors.js';
import { isSupport } from '../../plugins/auth.js';
import { loadProject, idParams, UUID } from '../projects/access.js';
import { loadChat, sendMessage, messageOut, MAX_BODY_CHARS } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOCKET_TTL_MS = 90_000;      // a socket slot expires unless its heartbeat refreshes it
const ACCESS_RECHECK_MS = 60_000;  // re-check chat access on delivery at most once a minute
const chatOut = (c) => ({
  id: c.id, kind: c.kind, projectId: c.project_id, subject: c.subject, status: c.status,
  createdAt: c.created_at.toISOString(), lastMessageAt: c.last_message_at ? c.last_message_at.toISOString() : null,
});

export default async function chatRoutes(app) {
  const { db, config, pubsub, redis } = app;
  const allowedOrigins = new Set(config.allowedOrigins);
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'no-store'); });

  app.post('/support/chats', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['subject'],
        properties: { subject: { type: 'string', minLength: 1, maxLength: 160 }, kind: { type: 'string', enum: ['support', 'project'], default: 'support' }, projectId: UUID },
      },
    },
  }, async (request, reply) => {
    const { subject, kind, projectId } = request.body;
    if (kind === 'project') {
      if (!projectId) throw badRequest('project_required', 'projectId is required for a project chat');
      await loadProject(db, projectId, request.user);
    } else if (projectId) {
      throw badRequest('unexpected_project', 'Support chats are not linked to a project');
    }
    const chat = (await db.query(
      'INSERT INTO chats (kind, project_id, subject, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [kind, kind === 'project' ? projectId : null, subject.trim(), request.user.id],
    )).rows[0];
    await db.query('INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)', [chat.id, request.user.id]);
    return reply.status(201).send(chatOut(chat));
  });

  app.get('/support/chats', {
    preHandler: app.authenticate,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['mine', 'queue'], default: 'mine' } } } },
  }, async (request) => {
    const u = request.user;
    if (request.query.scope === 'queue') {
      if (!isSupport(u)) throw forbidden('Support staff only');
      const { rows } = await db.query(
        "SELECT * FROM chats WHERE kind = 'support' AND status = 'open' ORDER BY last_message_at DESC NULLS LAST LIMIT 100",
      );
      return { items: rows.map(chatOut) };
    }
    const { rows } = await db.query(
      `SELECT c.* FROM chats c WHERE c.kind = 'support' AND EXISTS (SELECT 1 FROM chat_participants p WHERE p.chat_id = c.id AND p.user_id = $1)
       UNION ALL
       SELECT c.* FROM chats c JOIN projects pr ON pr.id = c.project_id AND pr.deleted_at IS NULL
        WHERE c.kind = 'project' AND (pr.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = pr.id AND m.user_id = $1))
       ORDER BY last_message_at DESC NULLS LAST LIMIT 100`,
      [u.id],
    );
    return { items: rows.map(chatOut) };
  });

  app.get('/support/chats/:id/messages', {
    preHandler: app.authenticate,
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
    },
  }, async (request) => {
    const chat = await loadChat(db, request.params.id, request.user);
    const { before, limit } = request.query;
    const { rows } = await db.query(
      `SELECT * FROM chat_messages WHERE chat_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [chat.id, before ?? null, limit],
    );
    return { items: rows.reverse().map(messageOut) };
  });

  // REST fallback for sending (same rules as the WebSocket path).
  app.post('/support/chats/:id/messages', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['clientMsgId', 'body'], properties: { clientMsgId: UUID, body: { type: 'string', minLength: 1, maxLength: MAX_BODY_CHARS } } },
    },
  }, async (request, reply) => {
    const { message, duplicate } = await sendMessage(app, request.user, request.params.id, request.body.clientMsgId, request.body.body);
    return reply.status(duplicate ? 200 : 201).send(message);
  });

  // ---------- WebSocket ----------
  // Upgrade is a GET, so the CSRF guard does not run: check Origin here (browsers always send it).
  const wsGuard = async (request) => {
    if (!request.headers.origin || !allowedOrigins.has(request.headers.origin)) throw forbidden('Request origin is not allowed');
    await app.authenticate(request);
  };

  app.get('/support/chats/ws', { websocket: true, preHandler: wsGuard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (socket, request) => {
    const user = request.user;
    const log = request.log.child({ ws: true, userId: user.id });
    const subs = new Map(); // chatId -> { unsubscribe, checkedAt, chain }
    const sockKey = `kb:ws:${user.id}`;
    const sockId = randomUUID();
    let window = { start: Date.now(), count: 0 };
    let alive = true;
    let closed = false;
    const send = (obj) => { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); };
    const close = (code, reason) => { if (!closed) socket.close(code, reason); };

    // Limit open sockets per user across all API copies. Each socket is a member of a sorted set scored
    // by its expiry, refreshed by the heartbeat, so sockets lost in a crash age out by themselves.
    // Fails open if Redis is down (chat still works). Messages wait for this check instead of being lost.
    const register = () => redis.zadd(sockKey, Date.now() + SOCKET_TTL_MS, sockId).then(() => redis.pexpire(sockKey, SOCKET_TTL_MS));
    const admitted = (async () => {
      try {
        await redis.zremrangebyscore(sockKey, '-inf', Date.now());
        await register();
        const open = await redis.zcard(sockKey);
        if (open > config.chat.maxSocketsPerUser) {
          await redis.zrem(sockKey, sockId).catch(() => {});
          close(1008, 'too many connections');
          return false;
        }
      } catch {
        // Redis unavailable: admit.
      }
      return true;
    })();

    // Access is re-checked when delivering, at most once a minute per chat, so a removed member or a
    // deleted project stops receiving messages without waiting for the token to expire.
    const deliver = (chatId, entry) => (ev) => {
      entry.chain = entry.chain.then(async () => {
        if (closed || !subs.has(chatId)) return;
        if (Date.now() - entry.checkedAt > (config.chat.accessRecheckMs ?? ACCESS_RECHECK_MS)) {
          try {
            await loadChat(app.db, chatId, user);
            entry.checkedAt = Date.now();
          } catch (err) {
            if (err.statusCode && err.statusCode < 500) {
              subs.delete(chatId);
              await entry.unsubscribe?.();
              send({ type: 'unsubscribed', chatId, reason: 'access_revoked' });
              return;
            }
            // Database hiccup: keep the last decision rather than dropping messages.
          }
        }
        send({ ...ev });
      });
    };

    // Close when the access token expires; the client refreshes and reconnects.
    const expiresInMs = request.tokenExp ? request.tokenExp * 1000 - Date.now() : 3600_000;
    const expiryTimer = setTimeout(() => close(4001, 'session expired'), Math.max(1000, Math.min(expiresInMs, 2 ** 31 - 1)));
    const pingTimer = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
      register().catch(() => {}); // keep this socket's slot alive
    }, 30_000);
    socket.on('pong', () => { alive = true; });

    socket.on('message', async (raw, isBinary) => {
      if (!(await admitted) || closed) return;
      if (isBinary || raw.length > config.chat.maxMessageBytes) return send({ type: 'error', code: 'message_too_large' });
      const now = Date.now();
      if (now - window.start > config.chat.rateWindowMs) window = { start: now, count: 0 };
      if (++window.count > config.chat.ratePerWindow) return send({ type: 'error', code: 'rate_limited' });
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return send({ type: 'error', code: 'bad_json' });
      }
      try {
        if (msg?.type === 'ping') return send({ type: 'pong' });
        if (!UUID_RE.test(String(msg?.chatId))) return send({ type: 'error', code: 'bad_chat_id' });
        const chatId = msg.chatId.toLowerCase();
        if (msg.type === 'subscribe') {
          await loadChat(app.db, chatId, user); // access check
          if (!subs.has(chatId)) {
            if (subs.size >= 20) return send({ type: 'error', code: 'too_many_subscriptions' });
            const entry = { unsubscribe: null, checkedAt: Date.now(), chain: Promise.resolve() };
            subs.set(chatId, entry);
            try {
              entry.unsubscribe = await pubsub.subscribe(`chat:${chatId}`, deliver(chatId, entry));
            } catch {
              subs.delete(chatId);
              return send({ type: 'error', code: 'live_unavailable', chatId, poll: `/api/v1/support/chats/${chatId}/messages` });
            }
            // The socket may have closed while we waited for Redis: do not leak the listener.
            if (closed || subs.get(chatId) !== entry) { await entry.unsubscribe(); return; }
          }
          return send({ type: 'subscribed', chatId });
        }
        if (msg.type === 'unsubscribe') {
          const entry = subs.get(chatId);
          subs.delete(chatId);
          await entry?.unsubscribe?.();
          return send({ type: 'unsubscribed', chatId });
        }
        if (msg.type === 'send') {
          if (!UUID_RE.test(String(msg.clientMsgId))) return send({ type: 'error', code: 'bad_client_msg_id' });
          const { message } = await sendMessage(app, user, chatId, msg.clientMsgId.toLowerCase(), msg.body);
          return send({ type: 'ack', clientMsgId: message.clientMsgId, message });
        }
        return send({ type: 'error', code: 'unknown_type' });
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) return send({ type: 'error', code: err.code, chatId: msg?.chatId });
        log.error({ err }, 'ws message failed');
        return send({ type: 'error', code: 'server_error' });
      }
    });

    socket.on('close', async () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(expiryTimer);
      // Wait for admission to settle first, so a socket that closes mid-check is still removed.
      await admitted.catch(() => {});
      redis.zrem(sockKey, sockId).catch(() => {});
      const entries = [...subs.values()];
      subs.clear();
      for (const e of entries) await e.unsubscribe?.();
    });
    if (await admitted) send({ type: 'ready', userId: user.id });
  });
}
