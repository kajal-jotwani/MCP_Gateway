import { loadConfig } from './config.js';
import type { NotesConfig } from './config.js';
import { createNotesHttpServer } from './http.js';

let config: NotesConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const server = createNotesHttpServer(config.token, new Map());
server.listen(config.port, () => {
  console.log(JSON.stringify({ event: 'listening', port: config.port }));
});
process.on('SIGTERM', () => server.close());
