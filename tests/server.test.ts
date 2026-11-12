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

async function runApp(mode: 'ok' | 'missing' | 'fail' | 'timeout' | 'no-process' | 'ports-fail') {
  const dir = await mkdtemp(join(tmpdir(), 'local-landing-test-'));
  const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('Hola') });
  const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const appPort = reservation.port;
  reservation.stop(true);
  const ss = join(dir, 'ss');
  const browser = join(dir, 'browser');
  await Bun.write(ss, `#!/bin/sh\nprintf 'LISTEN 0 128 127.0.0.1:${target.port} 0.0.0.0:*\\n'\n`);
  const browserScript = mode === 'fail' ? '#!/bin/sh\necho fallo-de-prueba >&2\nexit 42\n'
    : mode === 'timeout' ? '#!/bin/sh\nexec sleep 60\n'
    : mode === 'missing' ? '#!/bin/sh\nexit 0\n'
    : `#!/bin/sh\nfor arg do\n  case "$arg" in --screenshot=*) file=\${arg#--screenshot=};; esac\ndone\nprintf 'fake-png' > "$file"\n`;
  await Bun.write(browser, browserScript);
  const lsof = join(dir, 'lsof');
  const ps = join(dir, 'ps');
  const ports = join(dir, 'ports');
  await Bun.write(ports, mode === 'ports-fail' ? '#!/bin/sh\necho error-ports >&2\nexit 1\n' : `#!/bin/sh\nprintf '${target.port} LOCAL test-executable\\n'\n`);
  await Bun.write(lsof, mode === 'no-process' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nprintf "12345\\n"\n');
  await Bun.write(ps, '#!/bin/sh\nprintf "example --argument <value>\\n"\n');
  await Promise.all([ss, browser, lsof, ps, ports].map(path => chmod(path, 0o755)));
  const child = Bun.spawn([join(process.cwd(), 'dist/local-landing')], {
    env: { ...process.env, PORT: String(appPort), BROWSER: browser, PATH: `${dir}:${process.env.PATH}` },
    stdout: 'ignore', stderr: 'pipe',
  });
  return { dir, target, child, base: `http://127.0.0.1:${appPort}`, async cleanup() {
    child.kill(); await child.exited; target.stop(true); await rm(dir, {recursive: true, force: true});
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
    expect(data?.services).toEqual([{ port: app.target.port, hasImage: true, executable: 'test-executable', command: 'example --argument <value>' }]);
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
    expect(data.services).toEqual([{ port: app.target.port, hasImage: false, executable: 'test-executable', command: 'example --argument <value>' }]);
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
    expect(data.services).toEqual([{ port: app.target.port, hasImage: true, executable: 'test-executable', command: null }]);
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
    expect(data.services).toEqual([{ port: app.target.port, hasImage: true, executable: null, command: 'example --argument <value>' }]);
    expect(app.child.exitCode).toBeNull();
  } finally { await app.cleanup(); }
});

test('una captura fallida escribe el error y termina con código 1', async () => {
  const app = await runApp('fail');
  try {
    const stderr = new Response(app.child.stderr).text();
    expect(await app.child.exited).toBe(1);
    expect(await stderr).toContain('fallo-de-prueba');
  } finally { await app.cleanup(); }
});

test('un timeout de captura termina con código 1', async () => {
  const app = await runApp('timeout');
  try {
    const stderr = new Response(app.child.stderr).text();
    expect(await app.child.exited).toBe(1);
    expect(await stderr).toContain('timeout de 20s');
  } finally { await app.cleanup(); }
}, 30_000);
