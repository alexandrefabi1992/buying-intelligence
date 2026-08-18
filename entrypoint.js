'use strict';
// Entrypoint dispatcher — both Railway services (web + sync-worker) run the
// same image; the SERVICE_ROLE env var picks which top-level module to load.
//
// Values:
//   web         (default) — runs the Express API in server.js
//   sync-worker            — runs the multi-tenant sync loop in sync-worker.js
//
// Deploying without SERVICE_ROLE set is safe: it falls back to the web server,
// which is the historical behaviour before this dispatcher existed.

const role = (process.env.SERVICE_ROLE || 'web').trim();

console.log(`[entrypoint] SERVICE_ROLE='${role}'`);

switch (role) {
  case 'sync-worker':
    require('./sync-worker.js');
    break;
  case 'web':
    require('./server.js');
    break;
  default:
    console.error(`[entrypoint] unknown SERVICE_ROLE='${role}' — expected 'web' or 'sync-worker'`);
    process.exit(2);
}
