import { test, expect } from 'bun:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedHost, parseExecutableNames, parsePorts, respondsHttp } from '../src/server';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('parsea puertos IPv4 e IPv6, deduplica y excluye el propio', () => {
  expect(parsePorts('LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\nLISTEN 0 128 [::]:3000 [::]:*\nLISTEN 0 128 *:80 *:*\nLISTEN 0 128 [::1]:8080 [::]:*\n', 80)).toEqual([3000, 8080]);
  expect(isAllowedHost('127.0.0.1', 80)).toBe(true);
  expect(isAllowedHost('evil.example', 80)).toBe(false);
  expect(isAllowedHost('127.0.0.1:9999', 9999)).toBe(true);
});

test('asocia la tercera columna de ports a cada puerto válido', () => {
  expect([...parseExecutableNames('3000 LOCAL node\n  42   ANY  java\n3001 LOCAL\nmalformed line\n70000 ANY invalid\n')]).toEqual([[3000, 'node'], [42, 'java']]);
});

test('detecta HTTP sin seguir redirecciones', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, {status: 302, headers: {Location: 'https://example.com'}}) });
  try { expect(await respondsHttp(server.port)).toBe(true); }
  finally { server.stop(); }
});

async function runApp(mode: 'ok' | 'missing' | 'fail' | 'timeout' | 'no-process' | 'ports-fail' | 'waiting' | 'mixed') {
  const dir = await mkdtemp(join(tmpdir(), 'local-landing-test-'));
  const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('Hola') });
  const target2 = mode === 'mixed' ? Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('Hola 2') }) : null;
  const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const appPort = reservation.port;
  reservation.stop(true);
  const ss = join(dir, 'ss');
  const browser = join(dir, 'browser');
  const discoveryFailure = join(dir, 'ss-fail');
  await Bun.write(ss, `#!/bin/sh\n[ -f '${discoveryFailure}' ] && exit 1\nprintf 'LISTEN 0 128 127.0.0.1:${target.port} 0.0.0.0:*\\n'\n${target2 ? `printf 'LISTEN 0 128 127.0.0.1:${target2.port} 0.0.0.0:*\\n'` : ''}\n`);
  const browserMode = join(dir, 'browser-mode');
  const sessionReady = join(dir, 'session-ready');
  const launches = join(dir, 'launches');
  const browserEnvironment = join(dir, 'browser-environment');
  await Bun.write(browserMode, ['fail', 'timeout', 'missing', 'mixed'].includes(mode) ? mode : 'ok');
  if (mode !== 'waiting') await Bun.write(sessionReady, 'ready');
  await Bun.write(browser, `#!/bin/sh
printf 'launch\\n' >> '${launches}'
printf '%s\\n' "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" > '${browserEnvironment}'
mode=$(head -n 1 '${browserMode}')
for arg do
  case "$arg" in
    --screenshot=*) file=\${arg#--screenshot=};;
    http://*) url="$arg";;
  esac
done
[ "$mode" = mixed ] && [ "$url" != 'http://127.0.0.1:${target.port}/' ] && mode=ok
case "$mode" in
  fail|mixed) echo fallo-de-prueba >&2; exit 42;;
  timeout) exec sleep 60;;
  missing) exit 0;;
esac
printf 'fake-png' > "$file"
`);
  const systemctl = join(dir, 'systemctl');
  await Bun.write(systemctl, `#!/bin/sh
[ -f '${sessionReady}' ] || exit 1
state=$(head -n 1 '${sessionReady}')
case "$2:$4:$state" in
  is-active:xdg-desktop-portal.service:no-portal|is-active:xdg-desktop-portal-gtk.service:no-gtk) exit 1;;
  is-active:*) exit 0;;
  show-environment::no-display) printf 'XDG_RUNTIME_DIR=/tmp\\nDBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/test\\n';;
  show-environment:*) printf 'DISPLAY=:test\\nXDG_RUNTIME_DIR=/tmp\\nDBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/test\\n';;
  *) exit 1;;
esac
`);
  const lsof = join(dir, 'lsof');
  const ps = join(dir, 'ps');
  const ports = join(dir, 'ports');
  await Bun.write(ports, mode === 'ports-fail' ? '#!/bin/sh\necho error-ports >&2\nexit 1\n' : `#!/bin/sh\nprintf '${target.port} LOCAL test-executable\\n'\n`);
  await Bun.write(lsof, mode === 'no-process' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nprintf "12345\\n"\n');
  await Bun.write(ps, '#!/bin/sh\nprintf "example --argument <value>\\n"\n');
  await Promise.all([ss, browser, systemctl, lsof, ps, ports].map(path => chmod(path, 0o755)));
  const child = Bun.spawn([join(process.cwd(), 'dist/local-landing')], {
    env: { ...process.env, DISPLAY: ':stale', PORT: String(appPort), BROWSER: browser, PATH: `${dir}:${process.env.PATH}` },
    stdout: 'ignore', stderr: 'pipe',
  });
  return { dir, target, target2, child, browserMode, sessionReady, launches, browserEnvironment, discoveryFailure, base: `http://127.0.0.1:${appPort}`, async cleanup() {
    child.kill(); await child.exited; target.stop(true); target2?.stop(true); await rm(dir, {recursive: true, force: true});
  } };
}

test('el ejecutable sirve la página, imágenes y rechaza solicitudes de otros orígenes', async () => {
  const app = await runApp('ok');
  try {
    let data: { scanning: boolean; ports: number[]; services: { port: number; hasImage: boolean; executable: string | null; command: string | null }[] } | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        data = await (await fetch(`${app.base}/api/status`)).json();
        if (!data!.scanning) break;
      } catch {}
      await pause(50);
    }
    expect(data?.ports).toEqual([app.target.port]);
    expect(data?.services).toEqual([{ port: app.target.port, hasImage: true, executable: 'test-executable', command: 'example --argument <value>', capture: 'ready' }]);
    const html = await (await fetch(app.base)).text();
    expect(html).toContain('Local Landing');
    expect(html).toContain('/favicon.svg');
    const icon = await fetch(`${app.base}/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    expect(await icon.text()).toContain('<svg');
    expect(await (await fetch(`${app.base}/image/${app.target.port}`)).text()).toBe('fake-png');
    expect((await fetch(`${app.base}/api/status`, {headers: {Host: 'attacker.test'}})).status).toBe(403);
    expect((await fetch(`${app.base}/api/refresh`, {method: 'POST', headers: {Origin: 'http://evil.test', 'X-Local-Landing': 'refresh'}})).status).toBe(403);
    expect((await fetch(`${app.base}/api/refresh`, {method: 'POST', headers: {Origin: app.base, 'X-Local-Landing': 'refresh'}})).status).toBe(202);
  } finally { await app.cleanup(); }
});

test('una captura inexistente deja el servicio activo y sin imagen', async () => {
  const app = await runApp('missing');
  try {
    let data;
    for (let i = 0; i < 100; i++) {
      try {
        data = await (await fetch(`${app.base}/api/status`)).json();
        if (!data.scanning && data.version > 0) break;
      } catch {}
      await pause(50);
    }
    expect(data.services).toEqual([{ port: app.target.port, hasImage: false, executable: 'test-executable', command: 'example --argument <value>', capture: 'failed' }]);
    expect((await fetch(`${app.base}/image/${app.target.port}`)).status).toBe(404);
    expect(app.child.exitCode).toBeNull();
    expect((await fetch(`${app.base}/api/refresh`, {method: 'POST', headers: {Origin: app.base, 'X-Local-Landing': 'refresh'}})).status).toBe(202);
  } finally { await app.cleanup(); }
});

test('un proceso no disponible no impide mostrar el servicio', async () => {
  const app = await runApp('no-process');
  try {
    let data;
    for (let i = 0; i < 100; i++) {
      try {
        data = await (await fetch(`${app.base}/api/status`)).json();
        if (!data.scanning && data.version > 0) break;
      } catch {}
      await pause(50);
    }
    expect(data.services).toEqual([{ port: app.target.port, hasImage: true, executable: 'test-executable', command: null, capture: 'ready' }]);
    expect(app.child.exitCode).toBeNull();
  } finally { await app.cleanup(); }
});

test('un fallo de ports no impide mostrar el servicio', async () => {
  const app = await runApp('ports-fail');
  try {
    let data;
    for (let i = 0; i < 100; i++) {
      try {
        data = await (await fetch(`${app.base}/api/status`)).json();
        if (!data.scanning && data.version > 0) break;
      } catch {}
      await pause(50);
    }
    expect(data.services).toEqual([{ port: app.target.port, hasImage: true, executable: null, command: 'example --argument <value>', capture: 'ready' }]);
    expect(app.child.exitCode).toBeNull();
  } finally { await app.cleanup(); }
});

async function waitForStatus(base: string, predicate: (data: any) => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const data = await (await fetch(`${base}/api/status`)).json();
      if (predicate(data)) return data;
    } catch {}
    await pause(50);
  }
  throw new Error('Timeout esperando el estado de la aplicación');
}

async function refreshApp(base: string) {
  return fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base, 'X-Local-Landing': 'refresh' } });
}

test('espera la sesión sin lanzar el navegador y captura automáticamente cuando está lista', async () => {
  const app = await runApp('waiting');
  try {
    let data = await waitForStatus(app.base, data => !data.scanning && data.waitingForSession);
    expect(data.services[0].capture).toBe('pending');
    expect(await Bun.file(app.launches).exists()).toBe(false);
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && data.waitingForSession && data.version > 1);
    expect(data.services[0].hasImage).toBe(false);
    expect(await Bun.file(app.launches).exists()).toBe(false);
    for (const state of ['no-portal', 'no-gtk', 'no-display']) {
      await Bun.write(app.sessionReady, state);
      const oldVersion = data.version;
      await refreshApp(app.base);
      data = await waitForStatus(app.base, data => !data.scanning && data.waitingForSession && data.version > oldVersion);
      expect(await Bun.file(app.launches).exists()).toBe(false);
    }
    await Bun.write(app.sessionReady, 'ready');
    data = await waitForStatus(app.base, data => !data.scanning && data.services[0]?.capture === 'ready');
    expect(data.waitingForSession).toBe(false);
    expect(data.services[0].hasImage).toBe(true);
    expect(await Bun.file(app.browserEnvironment).text()).toBe(':test\nunix:path=/tmp/test\n');
  } finally { await app.cleanup(); }
}, 12_000);

test('un fallo no detiene las otras capturas y permite recuperarse', async () => {
  const app = await runApp('mixed');
  try {
    let data = await waitForStatus(app.base, data => !data.scanning && data.version > 1);
    expect(data.services.find((s: any) => s.port === app.target.port).capture).toBe('failed');
    expect(data.services.find((s: any) => s.port === app.target2!.port).capture).toBe('ready');
    expect(app.child.exitCode).toBeNull();
    await Bun.write(app.browserMode, 'ok');
    const oldVersion = data.version;
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && data.version > oldVersion);
    expect(data.services.every((s: any) => s.capture === 'ready')).toBe(true);
    await Bun.write(app.browserMode, 'fail');
    const nextVersion = data.version;
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && data.version > nextVersion);
    expect(data.services.every((s: any) => s.capture === 'stale' && s.hasImage)).toBe(true);
    expect(await (await fetch(`${app.base}/image/${app.target.port}`)).text()).toBe('fake-png');
  } finally { await app.cleanup(); }
});

test('un fallo de descubrimiento conserva los resultados y permite reintentar', async () => {
  const app = await runApp('ok');
  try {
    let data = await waitForStatus(app.base, data => !data.scanning && data.services[0]?.capture === 'ready');
    await Bun.write(app.discoveryFailure, 'fail');
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && data.refreshError);
    expect(data.services[0].capture).toBe('ready');
    expect(app.child.exitCode).toBeNull();
    await rm(app.discoveryFailure);
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && !data.refreshError);
    expect(data.services[0].capture).toBe('ready');
  } finally { await app.cleanup(); }
});

test('un timeout no detiene el servidor y una actualización posterior se recupera', async () => {
  const app = await runApp('timeout');
  try {
    let data = await waitForStatus(app.base, data => !data.scanning && data.services[0]?.capture === 'failed', 25_000);
    expect(app.child.exitCode).toBeNull();
    const oldVersion = data.version;
    await Bun.write(app.browserMode, 'ok');
    await refreshApp(app.base);
    data = await waitForStatus(app.base, data => !data.scanning && data.version > oldVersion);
    expect(data.services[0].capture).toBe('ready');
  } finally { await app.cleanup(); }
}, 30_000);
