import { startRobinhoodStandaloneServer } from '../robinhoodServer.js';

async function main() {
  const running = await startRobinhoodStandaloneServer();
  console.log(`Robinhood smart money radar: http://${running.host}:${running.port}/`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    running.server.closeSocialStreams?.();
    running.service.close();
    running.monitor.close();
    running.server.close(() => {
      running.socialService.close();
      running.store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
