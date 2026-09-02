export function enableTodoCors(app) {
  const requestHandlers = app.server.listeners('request');
  if (requestHandlers.length !== 1) {
    throw new Error('Expected Lambda to have one HTTP request handler.');
  }

  const handler = requestHandlers[0];
  app.server.removeListener('request', handler);
  app.server.on('request', (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const todoApi = pathname === '/api/todos' || pathname.startsWith('/api/todos/');
    const origin = String(request.headers.origin || '').trim();

    if (todoApi && origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '86400');

      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
    }

    handler(request, response);
  });

  return app;
}
