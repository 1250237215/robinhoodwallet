import { startRobinhoodStandaloneServer } from '../robinhoodServer.js';

async function main() {
  const running = await startRobinhoodStandaloneServer();
  console.log(`Robinhood smart money radar: http://${running.host}:${running.port}/`);
  const shutdown = () => {
    running.service.close();
    running.monitor.close();
    running.server.close(() => {
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
