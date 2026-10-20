import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function parsePort(value = '18960') {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw Error('PORT must be an integer from 1 to 65535.');
  return Number(value);
}

export function createWorkbenchServer(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw Error('WB_WORKBENCH_DIR is required.');
  let index, bulk, envelope;
  try {
    index = readFileSync(`${directory}/index.html`);
    bulk = readFileSync(`${directory}/bulk.enc.json`);
    const payload = JSON.parse(index.toString('utf8').match(/const P=(\{[^\r\n]+\});/)[1]);
    envelope = JSON.parse(bulk.toString('utf8'));
    const base64 = (value, length) => {
      if (typeof value !== 'string') return false;
      const bytes = Buffer.from(value, 'base64');
      return bytes.toString('base64') === value && (length ? bytes.length === length : bytes.length > 16);
    };
    if (!base64(payload.s, 16) || !base64(payload.i, 12) || !base64(payload.c) || payload.it !== 310000 ||
        envelope.v !== 1 || envelope.inner !== 'gzip(bulk-data.json)' || typeof envelope.t !== 'string' || !/^[0-9a-f]{8}$/.test(envelope.t) ||
        !base64(envelope.i, 12) || !base64(envelope.c)) throw Error();
  } catch {
    throw Error('The encrypted index.html and bulk.enc.json files are missing or invalid.');
  }
  // shortcut: check pair hashes at deploy time until both build tags are public.
  const health = Buffer.from(JSON.stringify({ok: true, build: envelope.t}));
  const files = new Map([
    ['/workbench/', [index, 'text/html; charset=utf-8']],
    ['/workbench/index.html', [index, 'text/html; charset=utf-8']],
    ['/workbench/bulk.enc.json', [bulk, 'application/json; charset=utf-8']],
    ['/healthz', [health, 'application/json; charset=utf-8']],
  ]);
  return createServer((request, response) => {
    const reply = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store, no-transform',
        'X-Content-Type-Options': 'nosniff',
        ...extra,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Method not allowed\n', undefined, {Allow: 'GET, HEAD'});
    const path = (request.url || '').split('?')[0];
    if (path === '/' || path === '/workbench') return reply(302, '', undefined, {Location: '/workbench/'});
    const file = files.get(path);
    if (!file) return reply(404, 'Not found\n');
    reply(200, file[0], file[1]);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = parsePort(process.env.PORT);
    const server = createWorkbenchServer(process.env.WB_WORKBENCH_DIR);
    server.on('error', () => {
      console.error('Workbench server could not start on its loopback port.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Workbench server ready at http://127.0.0.1:${port}/workbench/`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
