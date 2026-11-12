import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import page from './index.html' with { type: 'text' };
import favicon from './favicon.svg' with { type: 'text' };

const CAPTURE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;

export function parsePorts(output: string, ownPort: number): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const address = line.trim().split(/\s+/)[3];
    const match = address?.match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port > 0 && port <= 65535 && port !== ownPort) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function listeningPorts(ownPort: number): Promise<number[]> {
  const process = Bun.spawn(['ss', '-ltnH'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`ss falló (${code}): ${stderr.trim()}`);
  return parsePorts(stdout, ownPort);
}

export function parseExecutableNames(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+\S+\s+(\S+)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) names.set(port, match[2]);
  }
  return names;
}

async function executableNames(): Promise<Map<number, string>> {
  try {
    const executable = Bun.which('ports') ?? join(homedir(), 'update.d/bin/ports');
    const child = Bun.spawn([executable], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0 || stderr.trim()) throw new Error(`ports falló (${code}): ${stderr.trim()}`);
      return parseExecutableNames(stdout);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn(`No se pudo consultar ports: ${error}`);
    return new Map();
  }
}

export async function respondsHttp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function screenshot(port: number, directory: string): Promise<Uint8Array | null> {
  const path = join(directory, `${port}.png`);
  const browser = process.env.BROWSER || 'brave-browser-stable';
  const child = Bun.spawn([browser, '--headless', '--disable-gpu', `--screenshot=${path}`,
    '--window-size=1280,800', `http://127.0.0.1:${port}/`], { stdout: 'ignore', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CAPTURE_TIMEOUT_MS);
  const stderr = new Response(child.stderr).text();
  try {
    const code = await child.exited;
    const error = await stderr;
    if (timedOut) throw new Error(`Captura del puerto ${port}: timeout de ${CAPTURE_TIMEOUT_MS / 1000}s`);
    if (code !== 0) throw new Error(`Captura del puerto ${port}: navegador terminó con ${code}: ${error.trim()}`);
    const image = await readFile(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      console.warn(`Captura del puerto ${port}: el navegador no generó una imagen`);
      return null;
    });
    if (image === null) return null;
    if (image.length === 0) throw new Error('imagen vacía');
    return image;
  } catch (error) {
    throw new Error(`No se pudo generar la captura de ${port}: ${error}`);
  } finally {
    clearTimeout(timer);
  }
}

async function processCommand(port: number): Promise<string | null> {
  try {
    const lsof = Bun.spawn(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdout: 'pipe', stderr: 'ignore' });
    const [output, code] = await Promise.all([new Response(lsof.stdout).text(), lsof.exited]);
    if (code !== 0) return null;
    const pid = output.trim().split(/\s+/).at(-1);
    if (!pid || !/^\d+$/.test(pid)) return null;
    const ps = Bun.spawn(['ps', '-p', pid, '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
    const [args, psCode] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    return psCode === 0 ? args.trim() || null : null;
  } catch (error) {
    console.warn(`No se pudo consultar el proceso del puerto ${port}: ${error}`);
    return null;
  }
}

export function isAllowedHost(host: string | null, port: number): boolean {
  const suffix = port === 80 ? '' : ':' + port;
  return host === `127.0.0.1${suffix}` || host === `localhost${suffix}` ||
    (port === 80 && (host === '127.0.0.1:80' || host === 'localhost:80'));
}

async function main() {
  const port = Number(process.env.PORT || '80');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un puerto válido');
  let services = new Map<number, { image: Uint8Array | null; command: string | null; executable: string | null }>();
  let scanning = false;
  let version = 0;

  async function refresh() {
    if (scanning) return;
    scanning = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'local-landing-'));
      const ports = await listeningPorts(port);
      const names = await executableNames();
      const found: number[] = [];
      // Limit probes and browser launches: some local services do not speak HTTP.
      for (const candidate of ports) if (await respondsHttp(candidate)) found.push(candidate);
      const next = new Map<number, { image: Uint8Array | null; command: string | null; executable: string | null }>();
      for (const candidate of found) {
        console.log(`Capturando http://127.0.0.1:${candidate}/`);
        const image = await screenshot(candidate, directory);
        const command = await processCommand(candidate);
        next.set(candidate, { image, command, executable: names.get(candidate) ?? null });
      }
      services = next;
      version++;
      console.log(`Actualización completa: ${services.size} servicios HTTP`);
    } catch (error) {
      console.error('Local Landing:', error);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(console.error);
      process.exit(1);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(console.error);
      scanning = false;
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    fetch(request) {
      const host = request.headers.get('host');
      if (!isAllowedHost(host, port)) return new Response('Host no permitido', { status: 403 });
      const origin = request.headers.get('origin');
      if ((origin && origin !== `http://${host}`) || request.headers.get('sec-fetch-site') === 'cross-site') {
        return new Response('Origen no permitido', { status: 403 });
      }
      const path = new URL(request.url).pathname;
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (request.method === 'GET' && path === '/') {
        return new Response(page, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
      }
      if (request.method === 'GET' && path === '/favicon.svg') {
        return new Response(favicon, { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
      }
      if (request.method === 'GET' && path === '/favicon.ico') return new Response(null, { status: 204, headers });
      if (request.method === 'GET' && path === '/api/status') {
        return Response.json({ scanning, ports: [...services.keys()], version,
          services: [...services].map(([port, { image, command, executable }]) => ({ port, hasImage: image !== null, executable, command })) }, { headers });
      }
      if (request.method === 'GET' && /^\/image\/\d+$/.test(path)) {
        const image = services.get(Number(path.slice('/image/'.length)))?.image;
        return image ? new Response(image, { headers: { ...headers, 'Content-Type': 'image/png' } }) : new Response('No encontrada', { status: 404 });
      }
      if (request.method === 'POST' && path === '/api/refresh') {
        if (origin !== `http://${host}` || request.headers.get('x-local-landing') !== 'refresh') {
          return new Response('Origen no permitido', { status: 403 });
        }
        void refresh();
        return Response.json({ scanning: true }, { status: 202, headers });
      }
      return new Response('No encontrado', { status: 404 });
    },
  });
  console.log(`Local Landing escuchando en http://${server.hostname}:${server.port}/`);
  void refresh();
}

if (import.meta.main) {
  main().catch(error => { console.error('Local Landing:', error); process.exit(1); });
}
