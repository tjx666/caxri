import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { mobileReleaseApkUrl } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { MobileDeviceRegistry } from '../device-registry';
import type { MobileUpdateSource } from '../update-bundle';

export const MOBILE_UPDATE_DOWNLOAD_TTL_MS = 10 * 60_000;
const MAXIMUM_ACTIVE_DOWNLOADS = 2;
const TOKEN_BYTES = 32;
const DOWNLOAD_PATH = /^\/mobile\/update\/([0-9a-f]{64})$/u;

/**
 * Closed outcome for every update HTTP request that names the update path.
 */
export type MobileUpdateDownloadOutcome =
    'served' | 'unknownToken' | 'expired' | 'unauthorized' | 'capacity' | 'interrupted';

interface DownloadGrant {
    deviceId: string;
    expiresAt: number;
    generation: number;
    source: MobileUpdateSource;
}

export interface MobileUpdateDownloadsOptions {
    logger?: Pick<StructuredLogger, 'write'>;
    now: () => number;
    random: (bytes: number) => Uint8Array;
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>;
}

/**
 * Serves the bundled APK over the gateway's plain HTTP endpoint. Encrypting ~40 MB through the phone's pure-JavaScript
 * AES-GCM frame path would take minutes, so the sealed channel issues a single-device, short-lived bearer token and the
 * phone's native downloader fetches the bytes. Confidentiality of the APK is not required; integrity comes from the
 * sealed MD5 and Android's signing-certificate check on upgrade.
 */
export class MobileUpdateDownloads {
    readonly #grants = new Map<string, DownloadGrant>();
    readonly #options: MobileUpdateDownloadsOptions;
    #active = 0;

    constructor(options: MobileUpdateDownloadsOptions) {
        this.#options = options;
    }

    #rejection(grant: DownloadGrant | undefined): MobileUpdateDownloadOutcome | undefined {
        if (!grant) return 'unknownToken';
        if (grant.expiresAt <= this.#options.now()) return 'expired';
        try {
            this.#options.registry.currentPrincipal(grant.deviceId, grant.generation);
        } catch {
            return 'unauthorized';
        }
        if (this.#active >= MAXIMUM_ACTIVE_DOWNLOADS) return 'capacity';
        return undefined;
    }

    #removeExpired(): void {
        const now = this.#options.now();
        for (const [token, grant] of this.#grants)
            if (grant.expiresAt <= now) this.#grants.delete(token);
    }

    #record(outcome: MobileUpdateDownloadOutcome, startedAt: number, bytes: number): void {
        this.#options.logger?.write(
            outcome === 'served' ? 'info' : 'warn',
            logEventCatalog.mobileGateway.updateDownload,
            { fields: { bytes, durationMs: this.#options.now() - startedAt, outcome } },
        );
    }

    /**
     * Issues a fresh URL under `origin` and drops any earlier token of the same device, so one phone never holds two
     * live URLs.
     */
    issue(
        identity: { deviceId: string; generation: number },
        source: MobileUpdateSource,
        origin: string,
    ): { expiresAt: number; url: string } {
        this.#removeExpired();
        this.revokeDevice(identity.deviceId);
        const token = Buffer.from(this.#options.random(TOKEN_BYTES)).toString('hex');
        const expiresAt = this.#options.now() + MOBILE_UPDATE_DOWNLOAD_TTL_MS;
        this.#grants.set(token, { ...identity, expiresAt, source });
        return { expiresAt, url: `${origin}/mobile/update/${token}` };
    }

    /**
     * A Relay connection cannot reach the gateway's plain-HTTP endpoint, so it downloads the same release-signed APK
     * from its public GitHub Release instead and still checks it against the sealed MD5. No token is issued.
     */
    releaseAsset(source: MobileUpdateSource): { expiresAt: number; url: string } {
        return {
            expiresAt: this.#options.now() + MOBILE_UPDATE_DOWNLOAD_TTL_MS,
            url: mobileReleaseApkUrl(source.bundle.version),
        };
    }

    revokeDevice(deviceId: string): void {
        for (const [token, grant] of this.#grants)
            if (grant.deviceId === deviceId) this.#grants.delete(token);
    }

    clear(): void {
        this.#grants.clear();
    }

    /**
     * Returns `false` when the request is not an update download, letting the gateway keep its generic 404.
     */
    handle(request: IncomingMessage, response: ServerResponse): boolean {
        const match = request.method === 'GET' ? DOWNLOAD_PATH.exec(request.url ?? '') : null;
        if (!match) return false;
        const startedAt = this.#options.now();
        const grant = this.#grants.get(match[1]);
        const rejection = this.#rejection(grant);
        if (rejection || !grant) {
            this.#record(rejection ?? 'unknownToken', startedAt, 0);
            response.writeHead(rejection === 'capacity' ? 503 : 404, { Connection: 'close' }).end();
            return true;
        }
        this.#active += 1;
        const { apkPath, bundle } = grant.source;
        response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Connection': 'close',
            'Content-Length': String(bundle.sizeBytes),
            'Content-Type': 'application/vnd.android.package-archive',
        });
        void (async () => {
            try {
                await pipeline(createReadStream(apkPath), response);
                this.#record('served', startedAt, bundle.sizeBytes);
            } catch {
                this.#record('interrupted', startedAt, response.socket?.bytesWritten ?? 0);
                response.destroy();
            } finally {
                this.#active -= 1;
            }
        })();
        return true;
    }
}
