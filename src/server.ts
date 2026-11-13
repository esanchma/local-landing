import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import page from './index.html' with { type: 'text' };
import favicon from './favicon.svg' with { type: 'text' };

const CAPTURE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const READINESS_POLL_MS = 5_000;
const SESSION_VARIABLES = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'] as const;

type Service = { image: Uint8Array | null; command: string | null; executable: string | null; capture: 'pending' | 'ready' | 'stale' | 'failed' };

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

async function systemctl(args: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn(['systemctl', '--user', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 ? output : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

async function captureEnvironment(): Promise<Record<string, string> | null> {
  for (const unit of ['graphical-session.target', 'xdg-desktop-portal.service', 'xdg-desktop-portal-gtk.service']) {
    if (await systemctl(['is-active', '--quiet', unit]) === null) return null;
  }
  const output = await systemctl(['show-environment']);
  if (output === null) return null;
  const env: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    const name = line.slice(0, separator);
    if (separator > 0 && SESSION_VARIABLES.some(key => key === name)) env[name] = line.slice(separator + 1);
  }
  if (!(env.DISPLAY || env.WAYLAND_DISPLAY) || !env.XDG_RUNTIME_DIR || !env.DBUS_SESSION_BUS_ADDRESS) return null;
  return env;
}

async function screenshot(port: number, directory: string, session: Record<string, string>): Promise<Uint8Array | null> {
  const path = join(directory, `${port}.png`);
  const browser = process.env.BROWSER || 'brave-browser-stable';
  const env = { ...process.env };
  for (const key of SESSION_VARIABLES) delete env[key];
  Object.assign(env, session);
  const child = Bun.spawn([browser, '--headless', '--disable-gpu', `--screenshot=${path}`,
    '--window-size=1280,800', `http://127.0.0.1:${port}/`], { env, stdout: 'ignore', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CAPTURE_TIMEOUT_MS);
  const stderr = new Response(child.stderr).text();
  try {
    const code = await child.exited;
    if (timedOut) throw new Error(`Captura del puerto ${port}: timeout de ${CAPTURE_TIMEOUT_MS / 1000}s`);
    const error = await stderr;
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

async function discoverServices(port: number, previous: Map<number, Service>): Promise<Map<number, Service>> {
  const ports = await listeningPorts(port);
  const names = await executableNames();
  const next = new Map<number, Service>();
  for (const candidate of ports) {
    if (!await respondsHttp(candidate)) continue;
    const command = await processCommand(candidate);
    const executable = names.get(candidate) ?? null;
    const old = previous.get(candidate);
    const image = old?.command === command && old?.executable === executable ? old.image : null;
    next.set(candidate, { image, command, executable, capture: image ? 'stale' : 'pending' });
  }
  return next;
}

async function captureService(port: number, service: Service, directory: string, session: Record<string, string>) {
  console.log(`Capturando http://127.0.0.1:${port}/`);
  try {
    const image = await screenshot(port, directory, session);
    if (image) {
      service.image = image;
      service.capture = 'ready';
      return;
    }
  } catch (error) { console.error(error); }
  service.capture = service.image ? 'stale' : 'failed';
}

export function isAllowedHost(host: string | null, port: number): boolean {
  const suffix = port === 80 ? '' : ':' + port;
  return host === `127.0.0.1${suffix}` || host === `localhost${suffix}` ||
    (port === 80 && (host === '127.0.0.1:80' || host === 'localhost:80'));
}

async function main() {
  const port = Number(process.env.PORT || '80');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un puerto válido');
  let services = new Map<number, Service>();
  let scanning = false;
  let waitingForSession = false;
  let checkingSession = false;
  let refreshError = false;
  let version = 0;

  async function refresh() {
    if (scanning) return;
    scanning = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'local-landing-'));
      services = await discoverServices(port, services);
      waitingForSession = false;
      refreshError = false;
      version++;
      for (const [candidate, service] of services) {
        const session = await captureEnvironment();
        if (!session) {
          waitingForSession = true;
          break;
        }
        await captureService(candidate, service, directory, session);
        version++;
      }
      console.log(`Actualización completa: ${services.size} servicios HTTP`);
    } catch (error) {
      console.error('Local Landing:', error);
      refreshError = true;
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
          waitingForSession, refreshError,
          services: [...services].map(([port, { image, command, executable, capture }]) => ({ port, hasImage: image !== null, executable, command, capture })) }, { headers });
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
  setInterval(async () => {
    if (!waitingForSession || scanning || checkingSession) return;
    checkingSession = true;
    try {
      if (await captureEnvironment() && !scanning && waitingForSession) void refresh();
    } finally { checkingSession = false; }
  }, READINESS_POLL_MS);
}

if (import.meta.main) {
  main().catch(error => { console.error('Local Landing:', error); process.exit(1); });
}
