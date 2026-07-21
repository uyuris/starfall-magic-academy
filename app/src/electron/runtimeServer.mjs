export async function listenInternalServer({ server, host = '127.0.0.1', port }) {
  if (!server) throw new Error('server is required');

  const startedServer = await new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      if (error?.code === 'EADDRINUSE') {
        const wrapped = new Error(`Electron runtime を起動できません。固定 port ${port} はすでに使用中です。`);
        wrapped.code = 'ELECTRON_RUNTIME_PORT_IN_USE';
        wrapped.cause = error;
        reject(wrapped);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = startedServer.address();
  if (!address || typeof address === 'string') throw new Error('internal server address is unavailable');
  return {
    server: startedServer,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`
  };
}
