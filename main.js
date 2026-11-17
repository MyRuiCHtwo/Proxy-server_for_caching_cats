import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

// Resolve cache paths relative to the project, regardless of the shell's working directory.
const projectDir = fileURLToPath(new URL('.', import.meta.url));

// Use --help for help so that -h remains available for the required host option.
const program = new Command()
  .name('node main.js')
  .helpOption('--help', 'show help')
  .requiredOption('-h, --host <address>', 'HTTP listening address')
  .requiredOption('-p, --port <number>', 'HTTP listening port')
  .requiredOption('-c, --cache <path>', 'image cache directory inside the project');

// Send a readable text response and any method-specific HTTP headers.
function sendText(response, status, message, headers) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  response.end(message + '\n');
}

// Check the configuration and wait for Node to bind the listening socket.
async function start() {
  program.parse();
  const { host, port: rawPort, cache } = program.opts();
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    program.error('error: --port must be an integer between 1 and 65535');
  }

  // Keep runtime files inside the project while excluding the root and Git metadata.
  const cacheDir = resolve(projectDir, cache);
  const cachePath = relative(projectDir, cacheDir);
  const firstPart = cachePath.split(sep)[0].toLowerCase();
  if (!cache.trim() || !cachePath || isAbsolute(cachePath) || firstPart === '..' || firstPart === '.git') {
    program.error('error: --cache must name a cache directory inside the project');
  }

  const server = http.createServer(async (request, response) => {
    try {
      // Recursive mkdir also handles concurrent first requests and a cache removed between runs.
      await mkdir(cacheDir, { recursive: true });
      sendText(response, 404, 'Image route not found.');
    } catch (error) {
      console.error('Request failed:', error.message);
      sendText(response, 500, 'Unable to access the image cache.');
    }
  });

  // events.once exposes both successful startup and socket errors through a promise.
  await once(server.listen(port, host), 'listening');
  console.log(`Listening on ${host}:${port}`);
}

// Configuration and bind errors produce a nonzero exit status with a diagnostic.
try {
  await start();
} catch (error) {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
}
