import { config, assertConfig } from './config.js';
import { logger } from './logger.js';
import { startBot } from './bot/client.js';

const noWeb = process.argv.includes('--no-web');
const webEnabled = config.web.enabled && !noWeb;

assertConfig({ requireWeb: webEnabled });

let client = null;
let webServer = null;

try {
  client = await startBot();

  if (webEnabled) {
    const { startWeb } = await import('./web/server.js');
    webServer = await startWeb();
  } else {
    logger.info('web interface disabled');
  }
} catch (err) {
  logger.error('startup failed', { err: err.message, stack: err.stack });
  process.exit(1);
}

async function shutdown(signal) {
  logger.info('shutting down', { signal });
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref?.();
  try {
    await new Promise((resolve) => (webServer ? webServer.close(resolve) : resolve()));
    await client?.destroy();
    const { db } = await import('./db/index.js');
    db.close();
  } catch (err) {
    logger.error('shutdown error', { err: err.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection', { err: err?.message, stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception, exiting', { err: err?.message, stack: err?.stack });
  process.exit(1);
});
