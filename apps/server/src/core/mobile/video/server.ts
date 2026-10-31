import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { agentChatVideoByteRange, agentChatVideoContentType, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { isAllowedMobilePeer } from '../gateway/admission';
import { resolveMobileVideoFile } from './cited-video';

/**
 * How long one issued URL plays. A player re-requests ranges for as long as the user keeps it open and scrubs, so a URL
 * outlives a short preview launch; reopening the card issues a fresh one.
 */
const MOBILE_VIDEO_URL_TTL_MS = 60 * 60_000;
const MOBILE_VIDEO_IDLE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/**
 * Live URLs one device may hold; opening another drops its oldest.
 */
const MAXIMUM_GRANTS_PER_DEVICE = 8;
const TOKEN_BYTES = 32;
const VIDEO_PATH = /^\/mobile\/video\/([0-9a-f]{64})$/u;

/**
 * The paired device a video URL belongs to; every request re-checks it against the device registry.
 */
export interface MobileVideoGrant {
    deviceId: string;
    generation: number;
}

interface VideoUrlGrant extends MobileVideoGrant {
    expiresAt: number;
    /**
     * The path the message cites, resolved again on every request so a file replaced by a link to another file stops
     * playing.
     */
    path: string;
    resolvedPath: string;
}

/**
 * Closed reasons a video request was refused, aggregated per listener lifetime.
 */
type MobileVideoRejection = 'expired' | 'unauthorized' | 'unavailable' | 'unknownToken';

/**
 * Closed reasons a video listener stopped.
 */
type MobileVideoCloseReason = 'cleared' | 'idle';

interface VideoListener {
    address: string;
    closing: boolean;
    lastActivityAt: number;
    listenPort: number;
    /**
     * Responses still streaming; a listener with any is never idle.
     */
    openStreams: number;
    openedAt: number;
    server: Server;
    sockets: Set<Duplex>;
    stats: {
        bytes: number;
        interrupted: number;
        rangeRequests: number;
        rejected: Record<MobileVideoRejection, number>;
        requests: number;
    };
}

export interface MobileVideoServerOptions {
    /**
     * Whether the grant's device is still paired at that generation with a role that may play videos.
     */
    authorize: (grant: MobileVideoGrant) => boolean;
    idleMs?: number;
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    random: (bytes: number) => Uint8Array;
    sweepMs?: number;
}

/**
 * Streams the videos a phone plays from Chat cards over plain HTTP on the gateway address it is connected through, one
 * listener per address. A video is tens of megabytes, far too much for the phone's pure-JavaScript AES-GCM frame path,
 * and a native player needs a URL it can ask ranges of, so the sealed channel issues a single-device bearer URL instead
 * (`mobile.video.open`), as it does for update downloads. The listener is separate from the gateway's own, because that
 * one admits only ten TCP connections a minute per phone and a player opens a new one for every seek. Every request
 * must come from a private peer and belong to a device the registry still authorizes, and the file is resolved again
 * each time. Listeners close after {@link MOBILE_VIDEO_IDLE_MS} without traffic or when mobile access stops.
 */
export class MobileVideoServer {
    readonly #grants = new Map<string, VideoUrlGrant>();
    readonly #listeners = new Map<string, VideoListener>();
    readonly #starting = new Map<string, Promise<VideoListener>>();
    /**
     * Bumped by {@link clear}, so a listener that finishes binding after mobile access stopped closes instead.
     */
    #epoch = 0;
    readonly #options: MobileVideoServerOptions;
    readonly #now: () => number;
    #sweep?: ReturnType<typeof setInterval>;

    constructor(options: MobileVideoServerOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
    }

    async #start(address: string, epoch: number): Promise<VideoListener> {
        const now = this.#now();
        const server = createServer({ maxHeaderSize: 8 * 1_024 });
        server.keepAliveTimeout = 5_000;
        const listener: VideoListener = {
            address,
            closing: false,
            lastActivityAt: now,
            listenPort: 0,
            openStreams: 0,
            openedAt: now,
            server,
            sockets: new Set(),
            stats: {
                bytes: 0,
                interrupted: 0,
                rangeRequests: 0,
                rejected: { expired: 0, unauthorized: 0, unavailable: 0, unknownToken: 0 },
                requests: 0,
            },
        };
        server.on('connection', (socket) => {
            listener.sockets.add(socket);
            socket.once('close', () => listener.sockets.delete(socket));
        });
        server.on('request', (request, response) => {
            if (!isAllowedMobilePeer(request.socket.remoteAddress, request.socket.localAddress)) {
                request.socket.destroy();
                return;
            }
            void this.#serve(listener, request, response);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, address, () => {
                server.off('error', reject);
                resolve();
            });
        });
        if (epoch !== this.#epoch) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            throw new CaxriError('UNAVAILABLE', 'Mobile access stopped while the video opened');
        }
        const bound = server.address();
        listener.listenPort = typeof bound === 'object' && bound ? bound.port : 0;
        this.#listeners.set(address, listener);
        this.#sweep ??= setInterval(
            () => this.#sweepIdle(),
            this.#options.sweepMs ?? SWEEP_INTERVAL_MS,
        );
        this.#sweep.unref();
        return listener;
    }

    #rejection(grant: VideoUrlGrant | undefined): MobileVideoRejection | undefined {
        if (!grant) return 'unknownToken';
        if (grant.expiresAt <= this.#now()) return 'expired';
        if (!this.#options.authorize(grant)) return 'unauthorized';
        return undefined;
    }

    async #serve(listener: VideoListener, request: IncomingMessage, response: ServerResponse) {
        listener.lastActivityAt = this.#now();
        const match =
            request.method === 'GET' || request.method === 'HEAD'
                ? VIDEO_PATH.exec(request.url ?? '')
                : null;
        const grant = match ? this.#grants.get(match[1]) : undefined;
        const rejection = this.#rejection(grant);
        const file = grant && !rejection ? await resolveMobileVideoFile(grant.path) : undefined;
        const refused =
            rejection ??
            (!file || file.path !== grant?.resolvedPath ? ('unavailable' as const) : undefined);
        if (refused || !file) {
            listener.stats.rejected[refused ?? 'unavailable'] += 1;
            response.writeHead(refused === 'unauthorized' ? 403 : 404).end();
            return;
        }
        listener.stats.requests += 1;
        const headers = {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Type': agentChatVideoContentType(file.path),
        };
        const range = agentChatVideoByteRange(request.headers.range, file.size);
        if (range === 'unsatisfiable') {
            response.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` }).end();
            return;
        }
        if (range) listener.stats.rangeRequests += 1;
        const { start, end } = range ?? { start: 0, end: file.size - 1 };
        const length = file.size === 0 ? 0 : end - start + 1;
        response.writeHead(range ? 206 : 200, {
            ...headers,
            'Content-Length': String(length),
            ...(range && { 'Content-Range': `bytes ${start}-${end}/${file.size}` }),
        });
        if (length === 0 || request.method === 'HEAD') {
            response.end();
            return;
        }
        listener.openStreams += 1;
        try {
            await pipeline(createReadStream(file.path, { start, end }), response);
            listener.stats.bytes += length;
        } catch {
            // A player abandons the rest of a range whenever the user seeks, so this is routine, not a failure.
            listener.stats.interrupted += 1;
            response.destroy();
        } finally {
            listener.openStreams -= 1;
            listener.lastActivityAt = this.#now();
        }
    }

    #sweepIdle(): void {
        const idleMs = this.#options.idleMs ?? MOBILE_VIDEO_IDLE_MS;
        const now = this.#now();
        for (const [token, grant] of this.#grants)
            if (grant.expiresAt <= now || !this.#options.authorize(grant))
                this.#grants.delete(token);
        for (const listener of this.#listeners.values())
            if (listener.openStreams === 0 && now - listener.lastActivityAt >= idleMs)
                void this.#close(listener, 'idle');
    }

    async #close(listener: VideoListener, reason: MobileVideoCloseReason): Promise<void> {
        if (listener.closing) return;
        listener.closing = true;
        this.#listeners.delete(listener.address);
        if (this.#listeners.size === 0 && this.#sweep) {
            clearInterval(this.#sweep);
            this.#sweep = undefined;
        }
        const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()));
        for (const socket of listener.sockets) socket.destroy();
        await closed;
        const { rejected, ...counts } = listener.stats;
        this.#options.logger?.write('info', logEventCatalog.mobileGateway.videoClosed, {
            fields: {
                ...counts,
                durationMs: this.#now() - listener.openedAt,
                reason,
                rejectedExpired: rejected.expired,
                rejectedUnauthorized: rejected.unauthorized,
                rejectedUnavailable: rejected.unavailable,
                rejectedUnknownToken: rejected.unknownToken,
            },
        });
    }

    /**
     * Returns a URL that streams the cited video at `path` (resolved to `resolvedPath`) from the listener on `address`,
     * starting that listener when none is live.
     */
    async open(
        grant: MobileVideoGrant,
        address: string,
        file: { path: string; resolvedPath: string },
    ): Promise<string> {
        const epoch = this.#epoch;
        let listener = this.#listeners.get(address);
        if (!listener) {
            const starting = this.#starting.get(address) ?? this.#start(address, epoch);
            this.#starting.set(address, starting);
            try {
                listener = await starting;
            } finally {
                this.#starting.delete(address);
            }
        }
        if (epoch !== this.#epoch || listener.closing)
            throw new CaxriError('UNAVAILABLE', 'Mobile access stopped while the video opened');
        const now = this.#now();
        const owned = this.#grants
            .entries()
            .filter(([, held]) => held.deviceId === grant.deviceId)
            .toArray();
        // Make room for the new token by dropping the device's oldest ones.
        const oldest = owned.slice(0, Math.max(0, owned.length - MAXIMUM_GRANTS_PER_DEVICE + 1));
        for (const [token] of oldest) this.#grants.delete(token);
        const token = Buffer.from(this.#options.random(TOKEN_BYTES)).toString('hex');
        this.#grants.set(token, { ...grant, ...file, expiresAt: now + MOBILE_VIDEO_URL_TTL_MS });
        listener.lastActivityAt = now;
        return `http://${address}:${listener.listenPort}/mobile/video/${token}`;
    }

    async clear(): Promise<void> {
        this.#epoch += 1;
        this.#grants.clear();
        await Promise.all(this.#listeners.values().map((item) => this.#close(item, 'cleared')));
    }
}
