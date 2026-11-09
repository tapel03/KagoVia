// API process. Run several copies behind the load balancer; they share nothing but PostgreSQL and Redis.
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = await buildApp(config);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down: draining requests');
  const force = setTimeout(() => process.exit(1), 25_000);
  try {
    // Ask chat clients to reconnect elsewhere (1012 = service restart).
    for (const client of app.websocketServer?.clients ?? []) client.close(1012, 'server restarting');
    await app.close();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
  if (!config.isProd) app.log.debug(`\n${app.printRoutes({ commonPrefix: false })}`);
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
