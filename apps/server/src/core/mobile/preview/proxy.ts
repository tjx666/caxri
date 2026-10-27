import { Buffer } from 'node:buffer';
import type {
    IncomingHttpHeaders,
    IncomingMessage,
    OutgoingHttpHeaders,
    Server,
    ServerResponse,
} from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { connect } from 'node:net';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { isAllowedMobilePeer } from '../gateway/admission';

const MOBILE_PREVIEW_LAUNCH_TTL_MS = 60_000;
const MOBILE_PREVIEW_IDLE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAXIMUM_LISTENERS = 8;
const TOKEN_BYTES = 32;
const LAUNCH_PREFIX = '/__caxri_preview__/';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding'];

/**
 * The paired device a preview cookie belongs to; every request re-checks it against the device registry.
 */
export interface MobilePreviewGrant {
    deviceId: string;
    generation: number;
}

/**
 * Closed reasons a preview request was refused, aggregated per listener lifetime.
 */
type MobilePreviewRejection = 'address' | 'launchExpired' | 'unauthenticated' | 'unauthorized';

/**
 * Closed reasons a preview listener stopped.
 */
type MobilePreviewCloseReason = 'cleared' | 'evicted' | 'idle';

interface PreviewListener {
    address: string;
    closing: boolean;
    key: string;
    lastActivityAt: number;
    launches: Map<string, MobilePreviewGrant & { expiresAt: number }>;
    listenPort: number;
    /**
     * In-flight responses and open upgrade tunnels; a listener with any is never idle.
     */
    openStreams: number;
    openedAt: number;
    server: Server;
    sessions: Map<string, MobilePreviewGrant>;
    sockets: Set<Socket>;
    stats: {
        rejected: Record<MobilePreviewRejection, number>;
        requests: number;
        upgrades: number;
        upstreamErrors: number;
    };
    target: { host: string; port: number };
    /**
     * Each open upgrade tunnel's close function and the grant that admitted it, so a revoked device loses its tunnels.
     */
    tunnels: Map<() => void, MobilePreviewGrant>;
}

export interface MobilePreviewProxiesOptions {
    /**
     * Whether the grant's device is still paired at that generation with a role that may preview.
     */
    authorize: (grant: MobilePreviewGrant) => boolean;
    idleMs?: number;
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    random: (bytes: number) => Uint8Array;
    /**
     * How often idle listeners and revoked devices are swept; tests shorten it.
     */
    sweepMs?: number;
}

const previewToken = (random: (bytes: number) => Uint8Array): string =>
    Buffer.from(random(TOKEN_BYTES)).toString('hex');

const cookieName = (listener: PreviewListener): string => `caxri_preview_${listener.listenPort}`;

const readCookie = (header: string | undefined, name: string): string | undefined => {
    const pairs = header?.split(';') ?? [];
    for (const pair of pairs) {
        const separator = pair.indexOf('=');
        if (separator > 0 && pair.slice(0, separator).trim() === name)
            return pair.slice(separator + 1).trim();
    }
    return undefined;
};

const withoutCookie = (header: string, name: string): string =>
    header
        .split(';')
        .filter((pair) => pair.split('=', 1)[0]?.trim() !== name)
        .join(';')
        .trim();

/**
 * Makes the request look like it came from a browser on this computer. Dev servers commonly reject an unknown `Host`
 * (Vite's `server.allowedHosts`) or a cross-origin `Origin`, so both name `localhost:<port>`, and the preview cookie
 * stays on this side of the proxy.
 */
function forwardedRequestHeaders(
    headers: IncomingHttpHeaders,
    proxyOrigin: string,
    cookie: string,
    targetPort: number,
    isUpgrade: boolean,
): OutgoingHttpHeaders {
    const targetOrigin = `http://localhost:${targetPort}`;
    const forwarded: OutgoingHttpHeaders = { ...headers, host: `localhost:${targetPort}` };
    if (!isUpgrade) for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
    if (headers.origin) forwarded.origin = targetOrigin;
    if (headers.referer?.startsWith(proxyOrigin))
        forwarded.referer = targetOrigin + headers.referer.slice(proxyOrigin.length);
    if (headers.cookie) {
        const rest = withoutCookie(headers.cookie, cookie);
        if (rest) forwarded.cookie = rest;
        else delete forwarded.cookie;
    }
    return forwarded;
}

/**
 * Keeps the page on the proxy: an absolute redirect back to the dev server becomes a path, and a cookie scoped to
 * `Domain=localhost` would otherwise never be sent to the gateway address.
 */
function forwardedResponseHeaders(
    headers: IncomingHttpHeaders,
    targetPort: number,
): OutgoingHttpHeaders {
    const forwarded: OutgoingHttpHeaders = { ...headers };
    for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
    const location = headers.location;
    if (location) {
        const url = URL.canParse(location) ? new URL(location) : undefined;
        const port = url && Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        if (port === targetPort && url && LOCAL_HOSTNAMES.has(url.hostname))
            forwarded.location = `${url.pathname}${url.search}${url.hash}`;
    }
    if (headers['set-cookie'])
        forwarded['set-cookie'] = headers['set-cookie'].map((value) =>
            value.replaceAll(/;\s*domain=[^;]*/giu, ''),
        );
    return forwarded;
}

/**
 * Plain-HTTP reverse proxies that let a paired phone open a web server listening on this computer's loopback. Each
 * target gets its own listener on the gateway address, so a page's absolute paths and its WebSocket (a dev server's hot
 * reload) work unchanged. A single-use launch token, issued only over the sealed channel, becomes an HttpOnly cookie;
 * every later request must carry it, come from a private peer, and belong to a device the registry still authorizes.
 * Listeners close after {@link MOBILE_PREVIEW_IDLE_MS} without traffic or when mobile access stops.
 */
export class MobilePreviewProxies {
    readonly #listeners = new Map<string, PreviewListener>();
    /**
     * Listeners still binding, so concurrent opens of one target share a single listener.
     */
    readonly #starting = new Map<string, Promise<PreviewListener>>();
    /**
     * Bumped by {@link clear}, so a listener that finishes binding after mobile access stopped closes instead.
     */
    #epoch = 0;
    readonly #options: MobilePreviewProxiesOptions;
    readonly #now: () => number;
    #sweep?: ReturnType<typeof setInterval>;

    constructor(options: MobilePreviewProxiesOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
    }

    async #start(
        key: string,
        address: string,
        target: { host: string; port: number },
    ): Promise<PreviewListener> {
        if (this.#listeners.size >= MAXIMUM_LISTENERS) {
            const oldest = this.#listeners
                .values()
                .toArray()
                .toSorted((left, right) => left.lastActivityAt - right.lastActivityAt)
                .at(0);
            if (oldest) await this.#close(oldest, 'evicted');
        }
        const now = this.#now();
        const server = createServer({ maxHeaderSize: 16 * 1_024 });
        const listener: PreviewListener = {
            address,
            closing: false,
            key,
            lastActivityAt: now,
            launches: new Map(),
            listenPort: 0,
            openStreams: 0,
            openedAt: now,
            server,
            sessions: new Map(),
            sockets: new Set(),
            stats: {
                rejected: { address: 0, launchExpired: 0, unauthenticated: 0, unauthorized: 0 },
                requests: 0,
                upgrades: 0,
                upstreamErrors: 0,
            },
            target,
            tunnels: new Map(),
        };
        server.on('connection', (socket) => {
            listener.sockets.add(socket);
            socket.once('close', () => listener.sockets.delete(socket));
        });
        server.on('request', (request, response) => {
            const rejection = this.#admit(listener, request);
            if (rejection === 'address') {
                request.socket.destroy();
                return;
            }
            if ((request.url ?? '').startsWith(LAUNCH_PREFIX)) {
                this.#launch(listener, request, response);
                return;
            }
            if (rejection) {
                response
                    .writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                    .end('This preview has expired. Open it again from Caxri on your phone.');
                return;
            }
            this.#proxy(listener, request, response);
        });
        server.on('upgrade', (request, socket: Socket, head: Buffer) => {
            const grant = this.#admitted(listener, request);
            if (!grant) {
                socket.destroy();
                return;
            }
            this.#tunnel(listener, request, socket, head, grant);
        });
        const epoch = this.#epoch;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, address, () => {
                server.off('error', reject);
                resolve();
            });
        });
        if (epoch !== this.#epoch) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            throw new CaxriError('UNAVAILABLE', 'Mobile access stopped while the preview opened');
        }
        const bound = server.address();
        listener.listenPort = typeof bound === 'object' && bound ? bound.port : 0;
        this.#listeners.set(key, listener);
        this.#sweep ??= setInterval(
            () => this.#sweepIdle(),
            this.#options.sweepMs ?? SWEEP_INTERVAL_MS,
        );
        this.#sweep.unref();
        return listener;
    }

    /**
     * The refusal for a request, or `undefined` once its cookie maps to a device that is still authorized. A launch
     * request carries no cookie yet, so its `unauthenticated` result is ignored by the caller.
     */
    #admit(
        listener: PreviewListener,
        request: IncomingMessage,
    ): MobilePreviewRejection | undefined {
        const rejection = this.#rejection(listener, request);
        if (
            rejection &&
            !(rejection === 'unauthenticated' && request.url?.startsWith(LAUNCH_PREFIX))
        )
            listener.stats.rejected[rejection] += 1;
        else listener.lastActivityAt = this.#now();
        return rejection;
    }

    /**
     * The admitting grant of a request whose cookie maps to a device that is still authorized.
     */
    #admitted(listener: PreviewListener, request: IncomingMessage): MobilePreviewGrant | undefined {
        if (this.#admit(listener, request)) return undefined;
        const token = readCookie(request.headers.cookie, cookieName(listener));
        return token ? listener.sessions.get(token) : undefined;
    }

    #rejection(
        listener: PreviewListener,
        request: IncomingMessage,
    ): MobilePreviewRejection | undefined {
        if (!isAllowedMobilePeer(request.socket.remoteAddress, request.socket.localAddress))
            return 'address';
        const token = readCookie(request.headers.cookie, cookieName(listener));
        const grant = token ? listener.sessions.get(token) : undefined;
        if (!token || !grant) return 'unauthenticated';
        if (this.#options.authorize(grant)) return undefined;
        listener.sessions.delete(token);
        return 'unauthorized';
    }

    #launch(listener: PreviewListener, request: IncomingMessage, response: ServerResponse): void {
        const token = (request.url ?? '').slice(LAUNCH_PREFIX.length);
        const launch = listener.launches.get(token);
        listener.launches.delete(token);
        const isValid =
            request.method === 'GET' &&
            launch !== undefined &&
            launch.expiresAt > this.#now() &&
            this.#options.authorize(launch);
        if (!launch || !isValid) {
            listener.stats.rejected[launch ? 'unauthorized' : 'launchExpired'] += 1;
            response
                .writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end('This preview link has expired. Open it again from Caxri on your phone.');
            return;
        }
        const session = previewToken(this.#options.random);
        listener.sessions.set(session, {
            deviceId: launch.deviceId,
            generation: launch.generation,
        });
        response
            .writeHead(302, {
                'Cache-Control': 'no-store',
                'Location': '/',
                'Set-Cookie': `${cookieName(listener)}=${session}; Path=/; HttpOnly; SameSite=Lax`,
            })
            .end();
    }

    #proxyOrigin(listener: PreviewListener): string {
        return `http://${listener.address}:${listener.listenPort}`;
    }

    #proxy(listener: PreviewListener, request: IncomingMessage, response: ServerResponse): void {
        listener.stats.requests += 1;
        listener.openStreams += 1;
        const { host, port } = listener.target;
        const upstream = httpRequest(
            {
                headers: forwardedRequestHeaders(
                    request.headers,
                    this.#proxyOrigin(listener),
                    cookieName(listener),
                    port,
                    false,
                ),
                host,
                method: request.method,
                path: request.url,
                port,
            },
            (upstreamResponse) => {
                response.writeHead(
                    upstreamResponse.statusCode ?? 502,
                    forwardedResponseHeaders(upstreamResponse.headers, port),
                );
                // A dev server that dies mid-body would otherwise leave the phone waiting on a response that never ends.
                upstreamResponse.once('aborted', () => {
                    listener.stats.upstreamErrors += 1;
                    response.destroy();
                });
                upstreamResponse.pipe(response);
            },
        );
        upstream.on('error', () => {
            listener.stats.upstreamErrors += 1;
            if (response.headersSent) response.destroy();
            else
                response
                    .writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
                    .end(`Nothing answered on port ${port} of the computer.`);
        });
        response.once('close', () => {
            listener.openStreams -= 1;
            listener.lastActivityAt = this.#now();
            upstream.destroy();
        });
        request.pipe(upstream);
    }

    /**
     * Relays a WebSocket (or any HTTP upgrade) byte for byte after replaying the rewritten handshake.
     */
    #tunnel(
        listener: PreviewListener,
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
        grant: MobilePreviewGrant,
    ): void {
        listener.stats.upgrades += 1;
        listener.openStreams += 1;
        const { host, port } = listener.target;
        const upstream = connect({ host, port });
        let isClosed = false;
        const close = (): void => {
            if (isClosed) return;
            isClosed = true;
            listener.openStreams -= 1;
            listener.tunnels.delete(close);
            listener.lastActivityAt = this.#now();
            socket.destroy();
            upstream.destroy();
        };
        listener.tunnels.set(close, grant);
        upstream.once('connect', () => {
            const headers = forwardedRequestHeaders(
                request.headers,
                this.#proxyOrigin(listener),
                cookieName(listener),
                port,
                true,
            );
            const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
            for (const [name, value] of Object.entries(headers)) {
                const values = Array.isArray(value) ? value : [value];
                for (const item of values)
                    if (item !== undefined) lines.push(`${name}: ${String(item)}`);
            }
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        // `on`, not `once`: a destroyed socket can still emit a second write error while its pipe drains.
        upstream.on('error', () => {
            if (!isClosed) listener.stats.upstreamErrors += 1;
            close();
        });
        socket.on('error', close);
        upstream.once('close', close);
        socket.once('close', close);
    }

    /**
     * Closes idle listeners, and drops the cookies and upgrade tunnels of devices the registry no longer authorizes: a
     * request is checked when it starts, but a hot-reload socket can stay open long after the device was revoked.
     */
    #sweepIdle(): void {
        const idleMs = this.#options.idleMs ?? MOBILE_PREVIEW_IDLE_MS;
        const now = this.#now();
        for (const listener of this.#listeners.values()) {
            for (const [token, grant] of listener.sessions)
                if (!this.#options.authorize(grant)) listener.sessions.delete(token);
            for (const [close, grant] of listener.tunnels)
                if (!this.#options.authorize(grant)) close();
            if (listener.openStreams === 0 && now - listener.lastActivityAt >= idleMs)
                void this.#close(listener, 'idle');
        }
    }

    async #close(listener: PreviewListener, reason: MobilePreviewCloseReason): Promise<void> {
        if (listener.closing) return;
        listener.closing = true;
        this.#listeners.delete(listener.key);
        if (this.#listeners.size === 0 && this.#sweep) {
            clearInterval(this.#sweep);
            this.#sweep = undefined;
        }
        const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()));
        for (const socket of listener.sockets) socket.destroy();
        await closed;
        const { rejected, ...counts } = listener.stats;
        this.#options.logger?.write('info', logEventCatalog.mobileGateway.previewClosed, {
            fields: {
                ...counts,
                durationMs: this.#now() - listener.openedAt,
                reason,
                rejectedAddress: rejected.address,
                rejectedLaunchExpired: rejected.launchExpired,
                rejectedUnauthenticated: rejected.unauthenticated,
                rejectedUnauthorized: rejected.unauthorized,
            },
        });
    }

    /**
     * Returns a launch URL for `target`, reusing a live listener for the same address and target.
     */
    async open(
        grant: MobilePreviewGrant,
        address: string,
        target: { host: string; port: number },
    ): Promise<string> {
        const key = `${address}|${target.host}|${target.port}`;
        const existing = this.#listeners.get(key);
        let listener = existing;
        if (!listener) {
            const starting = this.#starting.get(key) ?? this.#start(key, address, target);
            this.#starting.set(key, starting);
            try {
                listener = await starting;
            } finally {
                this.#starting.delete(key);
            }
        }
        const now = this.#now();
        for (const [token, launch] of listener.launches)
            if (launch.expiresAt <= now) listener.launches.delete(token);
        const token = previewToken(this.#options.random);
        listener.launches.set(token, { ...grant, expiresAt: now + MOBILE_PREVIEW_LAUNCH_TTL_MS });
        listener.lastActivityAt = now;
        this.#options.logger?.write('info', logEventCatalog.mobileGateway.previewOpened, {
            fields: { listener: existing ? 'reused' : 'started' },
        });
        return `http://${address}:${listener.listenPort}${LAUNCH_PREFIX}${token}`;
    }

    async clear(): Promise<void> {
        this.#epoch += 1;
        await Promise.all(this.#listeners.values().map((item) => this.#close(item, 'cleared')));
    }
}
