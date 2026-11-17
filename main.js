import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import superagent from 'superagent';

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

// Publish a complete file in one rename. Remove the temporary file if writing or renaming fails.
async function saveImage(filePath, image) {
  const temporaryPath = filePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, image, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

// Fetch a JPEG as a Buffer. A failed request or an unexpected upstream reply means no image.
async function fetchImage(code) {
  try {
    const upstream = await superagent.get(`https://http.cat/${code}`)
      .timeout({ response: 5000, deadline: 10000 })
      .redirects(0)
      .maxResponseSize(5 * 1024 * 1024);
    if (upstream.status === 200 && upstream.type === 'image/jpeg' &&
        Buffer.isBuffer(upstream.body) && upstream.body.length > 0) {
      return upstream.body;
    }
  } catch (error) {
    console.error(`http.cat /${code}:`, error.message);
  }
  return null;
}

// Read from disk first, fetching and saving the original bytes only on a cache miss.
async function getImage(response, code, filePath) {
  let image;
  let source = 'cache';
  try {
    image = await readFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = 'http.cat';
    image = await fetchImage(code);
    if (!image) {
      sendText(response, 404, 'Image unavailable from http.cat.');
      return;
    }
    await saveImage(filePath, image);
  }

  response.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'X-Image-Source': source,
    'Cache-Control': 'no-store',
  });
  response.end(image);
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

      // Only the pathname is used as a key; the code must be exactly three decimal digits.
      const pathname = request.url.split('?', 1)[0];
      const route = /^\/([1-5]\d{2})$/.exec(pathname);
      if (!route) {
        sendText(response, 404, 'Use an image route such as /418.');
        return;
      }
      const code = route[1];
      const filePath = join(cacheDir, code + '.jpg');

      if (request.method === 'GET') {
        await getImage(response, code, filePath);
      } else {
        sendText(response, 405, 'Method not allowed.', { Allow: 'GET' });
      }
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
