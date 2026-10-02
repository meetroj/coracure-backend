/*
 * Serves the M-14 development call page.
 *
 * On port 5173 deliberately: that is the origin already in `CORS_ORIGINS` by
 * default, so the page can call the real API without loosening anything. And
 * over http://localhost rather than file://, because getUserMedia needs a
 * secure context and localhost counts as one.
 *
 *   node tools/dev-call/serve.js   ->   http://localhost:5173
 *
 * Development only. It serves one file and has no place in a deployment.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.DEV_CALL_PORT ?? 5173);
const PAGE = path.join(__dirname, 'index.html');

http
  .createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('ok');
    }
    fs.readFile(PAGE, (error, body) => {
      if (error) {
        response.writeHead(500);
        return response.end(String(error));
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });
  })
  .listen(PORT, () => {
    console.log(`M-14 dev call page: http://localhost:${PORT}`);
    console.log('Open it TWICE - once as the patient, once as the doctor.');
  });
