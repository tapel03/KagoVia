import { notFound, badRequest } from '../../lib/errors.js';
import { isSupport } from '../../plugins/auth.js';
import { loadProject } from '../projects/access.js';

export const MAX_BODY_CHARS = 4000;

// Access rule, checked on EVERY read and send:
//  support chat -> a participant, or support staff
//  project chat -> anyone with access to the project (owner or member)
export async function loadChat(db, chatId, user) {
  const chat = (await db.query('SELECT * FROM chats WHERE id = $1', [chatId])).rows[0];
  if (!chat) throw notFound('Chat not found');
  if (chat.kind === 'project') {
    await loadProject(db, chat.project_id, user);
    return chat;
  }
  if (isSupport(user)) return chat;
  const p = await db.query('SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2', [chatId, user.id]);
  if (!p.rowCount) throw notFound('Chat not found');
  return chat;
}

export const messageOut = (m) => ({
  id: m.id, chatId: m.chat_id, senderId: m.sender_id, clientMsgId: m.client_msg_id, body: m.body, createdAt: m.created_at.toISOString(),
});

// Saves first (PostgreSQL is the record), then fans out through Redis to every API copy.
// The same clientMsgId from the same sender is stored once, so client retries are safe.
export async function sendMessage({ db, pubsub }, user, chatId, clientMsgId, body) {
  const text = String(body ?? '').trim();
  if (!text || text.length > MAX_BODY_CHARS) throw badRequest('invalid_message', `Message must be 1 to ${MAX_BODY_CHARS} characters`);
  const chat = await loadChat(db, chatId, user);
  if (chat.status !== 'open') throw badRequest('chat_closed', 'This chat is closed');

  const inserted = await db.query(
    `INSERT INTO chat_messages (chat_id, sender_id, client_msg_id, body) VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id, sender_id, client_msg_id) DO NOTHING RETURNING *`,
    [chatId, user.id, clientMsgId, text],
  );
  if (!inserted.rows[0]) {
    const prev = (await db.query('SELECT * FROM chat_messages WHERE chat_id = $1 AND sender_id = $2 AND client_msg_id = $3',
      [chatId, user.id, clientMsgId])).rows[0];
    return { message: messageOut(prev), duplicate: true };
  }
  const msg = inserted.rows[0];
  await db.query('UPDATE chats SET last_message_at = $2 WHERE id = $1', [chatId, msg.created_at]);
  if (chat.kind === 'support') {
    // Support staff who reply become participants so the chat shows in their list.
    await db.query('INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [chatId, user.id]);
  }
  const out = messageOut(msg);
  await pubsub.publish(`chat:${chatId}`, { type: 'message', message: out });
  return { message: out, duplicate: false };
}
