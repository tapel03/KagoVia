// One Redis subscriber per process, shared by all SSE streams and chat sockets.
// Channels: gen:{generationId}, chat:{chatId}. Local listeners are reference-counted.

export class PubSub {
  constructor(publisher, subscriber, log) {
    this.pub = publisher;
    this.sub = subscriber;
    this.log = log;
    this.listeners = new Map(); // channel -> Set<fn>
    this.sub.on('message', (channel, message) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      let data;
      try {
        data = JSON.parse(message);
      } catch {
        return;
      }
      for (const fn of set) {
        try {
          fn(data);
        } catch (err) {
          this.log?.warn({ err }, 'pubsub listener failed');
        }
      }
    });
  }

  async publish(channel, data) {
    try {
      await this.pub.publish(channel, JSON.stringify(data));
      return true;
    } catch (err) {
      // Not fatal: data is already in PostgreSQL; clients catch up by replay or REST.
      this.log?.warn({ err: err.message, channel }, 'publish failed');
      return false;
    }
  }

  // Registers fn and resolves with an unsubscribe function. Rejects after timeoutMs if Redis does not
  // confirm (e.g. Redis down), and in that case removes fn again so nothing leaks.
  async subscribe(channel, fn, { timeoutMs = 2000 } = {}) {
    let set = this.listeners.get(channel);
    const isNew = !set;
    if (isNew) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(fn);
    // Local cleanup is immediate. The Redis UNSUBSCRIBE is fire-and-forget: awaiting it would hang
    // forever while Redis is down (its command would just sit in the offline queue).
    const unsubscribe = async () => {
      const s = this.listeners.get(channel);
      if (!s || !s.delete(fn)) return;
      if (s.size === 0) {
        this.listeners.delete(channel);
        this.confirmed?.delete(channel);
        this.sub.unsubscribe(channel).catch(() => {});
      }
    };
    if (isNew || !this.confirmed?.has(channel)) {
      let timer;
      try {
        await Promise.race([
          this.sub.subscribe(channel),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('subscribe timeout')), timeoutMs); }),
        ]);
        (this.confirmed ??= new Set()).add(channel);
      } catch (err) {
        await unsubscribe();
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    return unsubscribe;
  }
}
