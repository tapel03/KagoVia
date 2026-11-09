import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createTestApp, newUser, json, ORIGIN, token } from './helpers.js';
import { buildApp } from '../src/app.js';
import { jwks, fakeSupabase, fakePaystack } from './helpers.js';

// Two API copies on one database and Redis, to prove messages cross between servers.
let app;
let app2;
let base;
let base2;
before(async () => {
  ({ app } = await createTestApp());
  app2 = await buildApp(app.config, { jwks, supabase: fakeSupabase(), paystack: fakePaystack(), logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  await app2.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${app.server.address().port}/api/v1/support/chats/ws`;
  base2 = `ws://127.0.0.1:${app2.server.address().port}/api/v1/support/chats/ws`;
});
after(async () => {
  await app2.close();
  await app.close();
});

// Opens a socket and collects messages; resolves after the server says "ready".
function connect(url, jwt, { origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie: `kb_at=${jwt}`, ...(origin ? { origin } : {}) } });
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      inbox.push(m);
      waiters.splice(0).forEach((w) => w());
      if (m.type === 'ready') resolve(client);
    });
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.on('error', reject);
    ws.on('close', (code) => { client.closeCode = code; waiters.splice(0).forEach((w) => w()); });
    const client = {
      ws, inbox,
      send: (m) => ws.send(JSON.stringify(m)),
      async next(pred, ms = 3000) {
        const end = Date.now() + ms;
        for (;;) {
          const i = inbox.findIndex(pred);
          if (i >= 0) return inbox.splice(i, 1)[0];
          if (Date.now() > end) throw new Error(`no matching message; inbox=${JSON.stringify(inbox)}`);
          await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
        }
      },
      close: () => ws.close(),
    };
  });
}

test('project chat: owner and member on different servers see each other; outsider is refused', async () => {
  const owner = await newUser(app);
  const member = await newUser(app);
  const outsider = await newUser(app);
  const p = json(await owner.req('POST', '/api/v1/projects', { body: { name: 'Chat house', regionCode: 'GP' } }));
  await member.grant('customer');
  await app.db.query("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, 'viewer', $3)", [p.id, member.id, owner.id]);
  const chat = json(await owner.req('POST', '/api/v1/support/chats', { body: { kind: 'project', projectId: p.id, subject: 'Builder questions' } }));

  const a = await connect(base, owner.jwt);
  const b = await connect(base2, member.jwt); // other API copy
  const c = await connect(base, outsider.jwt);
  a.send({ type: 'subscribe', chatId: chat.id });
  b.send({ type: 'subscribe', chatId: chat.id });
  c.send({ type: 'subscribe', chatId: chat.id });
  await a.next((m) => m.type === 'subscribed');
  await b.next((m) => m.type === 'subscribed');
  assert.equal((await c.next((m) => m.type === 'error')).code, 'not_found');

  const clientMsgId = randomUUID();
  a.send({ type: 'send', chatId: chat.id, clientMsgId, body: 'Can we move the garage?' });
  const ack = await a.next((m) => m.type === 'ack');
  assert.equal(ack.message.body, 'Can we move the garage?');
  const got = await b.next((m) => m.type === 'message');
  assert.equal(got.message.body, 'Can we move the garage?');
  assert.equal(got.message.senderId, owner.id);

  // Retry with the same clientMsgId: stored once, acknowledged with the same message.
  a.send({ type: 'send', chatId: chat.id, clientMsgId, body: 'Can we move the garage?' });
  assert.equal((await a.next((m) => m.type === 'ack')).message.id, ack.message.id);
  // Outsider cannot send either.
  c.send({ type: 'send', chatId: chat.id, clientMsgId: randomUUID(), body: 'hi' });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'not_found');

  const history = json(await member.req('GET', `/api/v1/support/chats/${chat.id}/messages`));
  assert.equal(history.items.length, 1);
  assert.equal((await outsider.req('GET', `/api/v1/support/chats/${chat.id}/messages`)).statusCode, 404);
  [a, b, c].forEach((s) => s.close());
});

test('support chat: customer and support staff; REST fallback works the same', async () => {
  const customer = await newUser(app);
  const agent = await (await newUser(app)).grant('support');
  const chat = json(await customer.req('POST', '/api/v1/support/chats', { body: { subject: 'Payment question' } }));
  const queue = json(await agent.req('GET', '/api/v1/support/chats?scope=queue'));
  assert.ok(queue.items.some((x) => x.id === chat.id));
  assert.equal((await customer.req('GET', '/api/v1/support/chats?scope=queue')).statusCode, 403);

  const s = await connect(base2, agent.jwt);
  s.send({ type: 'subscribe', chatId: chat.id });
  await s.next((m) => m.type === 'subscribed');
  const sent = await customer.req('POST', `/api/v1/support/chats/${chat.id}/messages`, { body: { clientMsgId: randomUUID(), body: 'Hello?' } });
  assert.equal(sent.statusCode, 201);
  assert.equal((await s.next((m) => m.type === 'message')).message.body, 'Hello?');
  s.send({ type: 'send', chatId: chat.id, clientMsgId: randomUUID(), body: 'Hi, how can I help?' });
  await s.next((m) => m.type === 'ack');
  // The agent now lists the chat as theirs.
  assert.ok(json(await agent.req('GET', '/api/v1/support/chats')).items.some((x) => x.id === chat.id));
  s.close();
});

test('websocket security: bad origin, no login and expired tokens are refused; limits apply', async () => {
  const u = await newUser(app);
  await assert.rejects(connect(base, u.jwt, { origin: 'https://evil.example' }), (e) => e.status === 403);
  await assert.rejects(connect(base, u.jwt, { origin: null }), (e) => e.status === 403);
  await assert.rejects(connect(base, 'garbage'), (e) => e.status === 401);
  await assert.rejects(connect(base, await token(u.id, { expSeconds: -10 })), (e) => e.status === 401);

  const s = await connect(base, u.jwt);
  s.send({ type: 'subscribe', chatId: 'not-a-uuid' });
  assert.equal((await s.next((m) => m.type === 'error')).code, 'bad_chat_id');
  s.ws.send('{not json');
  assert.equal((await s.next((m) => m.type === 'error')).code, 'bad_json');
  s.send({ type: 'send', chatId: randomUUID(), clientMsgId: randomUUID(), body: 'x'.repeat(5000) });
  assert.equal((await s.next((m) => m.type === 'error')).code, 'message_too_large');
  for (let i = 0; i < 25; i++) s.send({ type: 'ping' });
  await s.next((m) => m.type === 'error' && m.code === 'rate_limited');
  s.close();

  // Too many sockets for one user.
  const sockets = [];
  for (let i = 0; i < app.config.chat.maxSocketsPerUser; i++) sockets.push(await connect(base, u.jwt));
  const extra = new WebSocket(base, { headers: { cookie: `kb_at=${u.jwt}`, origin: ORIGIN } });
  const code = await new Promise((r) => extra.on('close', r));
  assert.equal(code, 1008);
  sockets.forEach((x) => x.close());
});

test('review #7: a member removed from the project stops receiving chat messages', async () => {
  const owner = await newUser(app);
  const member = await newUser(app);
  await member.grant('customer');
  const p = json(await owner.req('POST', '/api/v1/projects', { body: { name: 'Revoke', regionCode: 'GP' } }));
  await app.db.query("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, 'viewer', $3)", [p.id, member.id, owner.id]);
  const chat = json(await owner.req('POST', '/api/v1/support/chats', { body: { kind: 'project', projectId: p.id, subject: 'x' } }));
  const m = await connect(base, member.jwt);
  m.send({ type: 'subscribe', chatId: chat.id });
  await m.next((x) => x.type === 'subscribed');
  await app.db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [p.id, member.id]);
  const saved = app.config.chat.accessRecheckMs;
  app.config.chat.accessRecheckMs = 0; // re-check on every delivery for this test
  try {
    await owner.req('POST', `/api/v1/support/chats/${chat.id}/messages`, { body: { clientMsgId: randomUUID(), body: 'secret plan' } });
    const gone = await m.next((x) => x.type === 'unsubscribed');
    assert.equal(gone.reason, 'access_revoked');
    assert.ok(!m.inbox.some((x) => x.type === 'message'));
  } finally {
    app.config.chat.accessRecheckMs = saved;
    m.close();
  }
});

test('review #8: socket slots of crashed connections expire instead of locking the user out', async () => {
  const u = await newUser(app);
  const key = `kb:ws:${u.id}`;
  // Five "ghost" sockets from a crash, already past their expiry.
  for (let i = 0; i < app.config.chat.maxSocketsPerUser; i++) await app.redis.zadd(key, Date.now() - 1000, `ghost-${i}`);
  const s = await connect(base, u.jwt);
  assert.equal(s.inbox.at(-1).type, 'ready');
  s.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await app.redis.zcard(key), 0);
});

test('websocket closes when the session token expires', async () => {
  const u = await newUser(app);
  const short = await token(u.id, { expSeconds: 2 });
  const s = await connect(base, short);
  await new Promise((r) => s.ws.on('close', r));
  assert.equal(s.closeCode, 4001);
});
