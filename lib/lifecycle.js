// Graceful shutdown on SIGINT / SIGTERM.
//
// Reusable PNDS core: the score server must release everything it owns
// (Socket.IO clients, audio engine, HTTP servers) when the host stops it.

const SHUTDOWN_LABEL = "[shutdown]";

function closeHttpServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function attachShutdown({ onShutdown, label = SHUTDOWN_LABEL }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${label} received ${signal}, cleaning up...`);

    try {
      await onShutdown();
      console.log(`${label} complete.`);
    } catch (error) {
      console.error(`${label} error:`, error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = {
  attachShutdown,
  closeHttpServer,
};
