import type { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import type { MobilePreviewGrant } from '../proxy';
import { MobilePreviewProxies } from '../proxy';

const GRANT: MobilePreviewGrant = { deviceId: 'device-1', generation: 1 };

/**
 * A distinct deterministic token per call, so launch tokens and cookies never collide.
 */
const tokenSequence = () => {
    let counter = 0;
    return (bytes: number): Uint8Array => {
        counter += 1;
        return new Uint8Array(bytes).fill(counter % 256);
    };
};

describe('MobilePreviewProxies', () => {
    let target: Server;
    let targetPort: number;
    let sockets: WebSocketServer;
    let isAuthorized: boolean;
    let now: number;
    let proxies: MobilePreviewProxies;

    beforeEach(async () => {
        isAuthorized = true;
        now = 1_000;
        target = createServer((request, response) => {
            if (request.url === '/redirect') {
                response
                    .writeHead(302, {
                        'Location': `http://localhost:${targetPort}/next`,
                        'Set-Cookie': 'theme=dark; Domain=localhost; Path=/',
                    })
                    .end();
                return;
            }
            response
                .writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ headers: request.headers, url: request.url }));
        });
        sockets = new WebSocketServer({ server: target });
        sockets.on('connection', (socket, request) => {
            socket.send(`origin=${request.headers.origin} host=${request.headers.host}`);
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        targetPort = (target.address() as AddressInfo).port;
        proxies = new MobilePreviewProxies({
            authorize: () => isAuthorized,
            now: () => now,
            random: tokenSequence(),
        });
    });

    afterEach(async () => {
        await proxies.clear();
        sockets.close();
        await new Promise<void>((resolve) => target.close(() => resolve()));
    });

    const launch = async () => {
        const url = await proxies.open(GRANT, '127.0.0.1', { host: '127.0.0.1', port: targetPort });
        const response = await fetch(url, { redirect: 'manual' });
        const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        return { cookie, origin: new URL(url).origin, response, url };
    };

    it('trades a launch token for a cookie and proxies as a local browser', async () => {
        const { cookie, origin, response } = await launch();
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/');
        expect(response.headers.get('set-cookie')).toContain('HttpOnly');

        const page = await fetch(`${origin}/assets/app.js?v=1`, {
            headers: { cookie: `${cookie}; app=1`, origin, referer: `${origin}/page` },
        });
        const echoed = (await page.json()) as { headers: Record<string, string>; url: string };
        expect(echoed.url).toBe('/assets/app.js?v=1');
        expect(echoed.headers.host).toBe(`localhost:${targetPort}`);
        expect(echoed.headers.origin).toBe(`http://localhost:${targetPort}`);
        expect(echoed.headers.referer).toBe(`http://localhost:${targetPort}/page`);
        expect(echoed.headers.cookie).toBe('app=1');
    });

    it('keeps redirects and cookies on the proxy', async () => {
        const { cookie, origin } = await launch();
        const response = await fetch(`${origin}/redirect`, {
            headers: { cookie },
            redirect: 'manual',
        });
        expect(response.headers.get('location')).toBe('/next');
        expect(response.headers.get('set-cookie')).toBe('theme=dark; Path=/');
    });

    it('refuses requests without a cookie, a reused launch token, and an expired one', async () => {
        const { origin, url } = await launch();
        expect((await fetch(`${origin}/`)).status).toBe(403);
        expect((await fetch(url, { redirect: 'manual' })).status).toBe(403);

        const late = await proxies.open(GRANT, '127.0.0.1', {
            host: '127.0.0.1',
            port: targetPort,
        });
        now += 61_000;
        expect((await fetch(late, { redirect: 'manual' })).status).toBe(403);
    });

    it('keeps the launch token for the real GET when a HEAD, POST, or prefetch arrives first', async () => {
        const url = await proxies.open(GRANT, '127.0.0.1', { host: '127.0.0.1', port: targetPort });
        expect((await fetch(url, { method: 'HEAD', redirect: 'manual' })).status).toBe(403);
        expect((await fetch(url, { method: 'POST', redirect: 'manual' })).status).toBe(403);
        expect(
            (
                await fetch(url, {
                    headers: { 'Sec-Purpose': 'prefetch;prerender' },
                    redirect: 'manual',
                })
            ).status,
        ).toBe(403);
        expect(
            (await fetch(url, { headers: { Purpose: 'prefetch' }, redirect: 'manual' })).status,
        ).toBe(403);

        const response = await fetch(url, { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('set-cookie')).toContain('HttpOnly');
        expect((await fetch(url, { redirect: 'manual' })).status).toBe(403);
    });

    it('stops serving a device the registry no longer authorizes', async () => {
        const { cookie, origin } = await launch();
        isAuthorized = false;
        expect((await fetch(`${origin}/`, { headers: { cookie } })).status).toBe(403);
        isAuthorized = true;
        // The revoked cookie is forgotten, so re-pairing the same device does not revive it.
        expect((await fetch(`${origin}/`, { headers: { cookie } })).status).toBe(403);
    });

    it('relays a WebSocket upgrade with local Host and Origin', async () => {
        const { cookie, origin } = await launch();
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/hmr`, {
            headers: { cookie, origin },
        });
        const message = await new Promise<string>((resolve, reject) => {
            socket.once('message', (data: Buffer) => resolve(data.toString('utf8')));
            socket.once('error', reject);
        });
        socket.close();
        expect(message).toBe(`origin=http://localhost:${targetPort} host=localhost:${targetPort}`);
    });

    it('reuses one listener per target', async () => {
        const first = await proxies.open(GRANT, '127.0.0.1', {
            host: '127.0.0.1',
            port: targetPort,
        });
        const second = await proxies.open(GRANT, '127.0.0.1', {
            host: '127.0.0.1',
            port: targetPort,
        });
        expect(new URL(first).port).toBe(new URL(second).port);
        expect(first).not.toBe(second);
    });

    it('answers 502 when nothing listens on the target any more', async () => {
        const { cookie, origin } = await launch();
        await new Promise<void>((resolve) => {
            for (const client of sockets.clients) client.terminate();
            target.close(() => resolve());
            target.closeAllConnections();
        });
        const response = await fetch(`${origin}/`, { headers: { cookie } });
        expect(response.status).toBe(502);
        target = createServer();
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    });

    it('shares one listener between concurrent opens and closes one that binds after clear', async () => {
        const target = { host: '127.0.0.1', port: targetPort };
        const [first, second] = await Promise.all([
            proxies.open(GRANT, '127.0.0.1', target),
            proxies.open(GRANT, '127.0.0.1', target),
        ]);
        expect(new URL(first).port).toBe(new URL(second).port);

        await proxies.clear();
        const late = proxies.open(GRANT, '127.0.0.1', { ...target, port: targetPort + 1 });
        await proxies.clear();
        await expect(late).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('never keeps more than eight listeners alive under concurrent opens of distinct targets', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 12 }, (_, index) =>
                proxies.open(GRANT, '127.0.0.1', { host: '127.0.0.1', port: targetPort + index }),
            ),
        );
        const urls = results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
        );
        expect(urls.length).toBeGreaterThan(0);
        const live = await Promise.all(
            urls.map(async (url) => {
                try {
                    await fetch(url, { redirect: 'manual' });
                    return true;
                } catch {
                    return false;
                }
            }),
        );
        expect(live.filter(Boolean).length).toBeLessThanOrEqual(8);
    });

    it('does not return a launch URL for a listener that clear() raced past an eviction', async () => {
        const open = (index: number) =>
            proxies.open(GRANT, '127.0.0.1', { host: '127.0.0.1', port: targetPort + index });
        await Promise.all(Array.from({ length: 8 }, (_, index) => open(index)));
        // The ninth target waits for the eviction of the oldest listener; clear() lands in that window.
        const ninth = open(8);
        await proxies.clear();
        const outcome = await Promise.allSettled([ninth]);
        const [result] = outcome;
        if (result.status === 'fulfilled')
            await expect(fetch(result.value, { redirect: 'manual' })).rejects.toThrow();
        else expect(result.reason).toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('closes the WebSocket tunnel of a device the registry revokes', async () => {
        await proxies.clear();
        proxies = new MobilePreviewProxies({
            authorize: () => isAuthorized,
            now: () => now,
            random: tokenSequence(),
            sweepMs: 20,
        });
        const { cookie, origin } = await launch();
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/hmr`, {
            headers: { cookie, origin },
        });
        await new Promise((resolve, reject) => {
            socket.once('message', resolve);
            socket.once('error', reject);
        });
        const closed = new Promise((resolve) => socket.once('close', resolve));
        isAuthorized = false;
        await closed;
        expect(socket.readyState).toBe(WebSocket.CLOSED);
    });
});
