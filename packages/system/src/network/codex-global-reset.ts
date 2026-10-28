import { Buffer } from 'node:buffer';

import type { CodexGlobalReset, CodexGlobalResetFailureReason } from '@caxri/protocol';
import { codexGlobalResetSchema, logEventCatalog } from '@caxri/protocol';

import type { StructuredLogger } from '../observability/logger.js';
import { SingleFlight } from '../process/single-flight.js';
import type { CappedBodyEnd } from './read-capped-body.js';
import { readCappedBody } from './read-capped-body.js';

type Fetch = (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/**
 * The tracker's public forecast. Its developer page documents `official_signal` and `last_reset_at` among the fields a
 * consumer may build on.
 */
export const CODEX_GLOBAL_RESET_FORECAST_URL = 'https://codex-reset.com/api/forecast';

const FETCH_TIMEOUT_MS = 10_000;
/**
 * The forecast is a few KiB; anything far larger is not the forecast.
 */
const MAX_FORECAST_BYTES = 512 * 1024;
/**
 * Announcements land hours ahead of the reset, so a few minutes of caching never costs a user the countdown while every
 * window shares one request.
 */
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;

class ForecastReadError extends Error {
    constructor(readonly reason: CodexGlobalResetFailureReason) {
        super(reason);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The chip promises to open the announcement on X, so a link anywhere else is not one.
 */
const ANNOUNCEMENT_HOSTS = new Set(['x.com', 'twitter.com']);

function isAnnouncementUrl(value: unknown): value is string {
    if (typeof value !== 'string' || !URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && ANNOUNCEMENT_HOSTS.has(url.hostname);
}

function timestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads the forecast into the reset Caxri counts down to. Only an announcement whose window names a target time counts:
 * a vague promise ("soon") has nothing to count down to, and one the tracker already saw land (`last_reset_at` at or
 * after the announcement) is over even when its deadline has not passed. Returns undefined for a body without the
 * documented shape.
 */
export function parseCodexGlobalResetForecast(
    body: unknown,
    checkedAt: number,
): CodexGlobalReset | undefined {
    if (!isRecord(body)) return undefined;
    const signal = body.official_signal;
    if (signal === null || signal === undefined) return { state: 'none', checkedAt };
    if (!isRecord(signal)) return undefined;
    const window = isRecord(signal.window) ? signal.window : undefined;
    const targetAt = timestamp(window?.target_at);
    const announcedAt = timestamp(signal.at);
    const lastResetAt = timestamp(body.last_reset_at);
    const postUrl = isAnnouncementUrl(signal.url) ? signal.url : undefined;
    if (
        targetAt === undefined ||
        announcedAt === undefined ||
        postUrl === undefined ||
        (lastResetAt !== undefined && lastResetAt >= announcedAt)
    )
        return { state: 'none', checkedAt };
    return {
        state: 'scheduled',
        checkedAt,
        targetAt,
        targetKind: window?.target_kind === 'deadline' ? 'deadline' : 'exact',
        announcedAt,
        quote: typeof signal.summary === 'string' ? signal.summary.slice(0, 500) : '',
        postUrl,
    };
}

async function fetchForecast(fetch: Fetch, userAgent: string): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(CODEX_GLOBAL_RESET_FORECAST_URL, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            // The tracker's terms ask readers to identify themselves; anonymous traffic is cut first.
            headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
        });
    } catch {
        throw new ForecastReadError('network');
    }
    if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ForecastReadError('http');
    }
    const chunks: Uint8Array[] = [];
    let end: CappedBodyEnd;
    try {
        end = await readCappedBody(response, MAX_FORECAST_BYTES, (chunk) => {
            chunks.push(chunk);
        });
    } catch {
        throw new ForecastReadError('network');
    }
    if (end !== 'end') throw new ForecastReadError('invalidResponse');
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
        throw new ForecastReadError('invalidResponse');
    }
}

/**
 * The next announced Codex global reset, cached for every caller. Desktop Main passes Electron's `net.fetch` so the
 * system proxy applies; an E2E launch passes a fetch that never leaves the machine. A tracker that stays down logs once
 * per reason, and its recovery is recorded as a transition.
 */
export function createCodexGlobalReset(options: {
    fetch: Fetch;
    /**
     * Read on each request rather than at construction, so building the reader never touches the host app.
     */
    userAgent: () => string;
    logger?: () => Pick<StructuredLogger, 'write'> | undefined;
    now?: () => number;
}) {
    const now = options.now ?? Date.now;
    let cached: { value: CodexGlobalReset; expiresAt: number } | undefined;
    const inFlight = new SingleFlight<'forecast', CodexGlobalReset>();
    let failing: CodexGlobalResetFailureReason | undefined;

    function recordOutcome(reason: CodexGlobalResetFailureReason | undefined): void {
        if (failing === reason) return;
        const logger = options.logger?.();
        if (reason) {
            logger?.write('warn', logEventCatalog.externalStatus.codexGlobalResetFailed, {
                fields: { reason },
            });
        } else if (failing) {
            logger?.write('info', logEventCatalog.externalStatus.codexGlobalResetRecovered, {
                fields: { previousReason: failing },
            });
        }
        failing = reason;
    }

    async function refresh(): Promise<CodexGlobalReset> {
        const checkedAt = now();
        let value: CodexGlobalReset;
        try {
            const parsed = parseCodexGlobalResetForecast(
                await fetchForecast(options.fetch, options.userAgent()),
                checkedAt,
            );
            if (!parsed) throw new ForecastReadError('invalidResponse');
            // Validated here so a forecast that changed shape fails with a reason instead of at the IPC boundary.
            const checked = codexGlobalResetSchema.safeParse(parsed);
            if (!checked.success) throw new ForecastReadError('invalidResponse');
            value = checked.data;
            recordOutcome(undefined);
        } catch (error) {
            const reason = error instanceof ForecastReadError ? error.reason : 'invalidResponse';
            value = { state: 'unavailable', checkedAt, reason };
            recordOutcome(reason);
        }
        cached = {
            value,
            expiresAt:
                checkedAt + (value.state === 'unavailable' ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
        };
        return value;
    }

    return async (): Promise<CodexGlobalReset> => {
        if (cached && cached.expiresAt > now()) return cached.value;
        return inFlight.run('forecast', refresh);
    };
}
