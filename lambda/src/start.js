import { createApp } from './server.js';
import { enableTodoCors } from './todo-cors.js';

const app = enableTodoCors(createApp());
await app.listen();

console.log(`Lambda is listening on http://${app.config.host}:${app.config.port}`);
if (app.config.password === 'changeme') {
  console.warn('WARNING: Using the default password. Set APP_PASSWORD or configure the add-on password.');
}
