import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentProvider,
    AgentProviderStatus,
    AgentProviderStatusComponent,
    AgentProviderStatusFailureReason,
} from '@caxri/protocol';
import { agentProviderStatusSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ParsedStatusPage } from './agent-provider-status-parsers';
import {
    parseClaudeStatusPage,
    parseCodexStatusPage,
    parseIncidentIoHistory,
    worstStatus,
} from './agent-provider-status-parsers';
import type { CappedBodyEnd } from './read-capped-body';
import { readCappedBody } from './read-capped-body';

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const FETCH_TIMEOUT_MS = 10_000;
/**
 * The largest status response read. The Statuspage summary is about 6 KiB and the 90-day incident.io impact history
 * about 100 KiB, so this leaves an order of magnitude of headroom while a runaway body never buffers whole in Main.
 */
const MAX_STATUS_PAGE_BYTES = 2 * 1024 * 1024;
/**
 * Both pages publish a component change within a minute or two of an incident being declared, so a minute of caching
 * loses nothing a user acts on while every hover card and open status page share one request per provider.
 */
const SUCCESS_TTL_MS = 60_000;
/**
 * A failed read is remembered for less time, so an Agent status page left open picks the page back up soon after the
 * network returns, without retrying on every hover while it is down.
 */
const FAILURE_TTL_MS = 30_000;
/**
 * The history window status.openai.com itself draws (`history_window_days`).
 */
const HISTORY_WINDOW_MS = 90 * 86_400_000;

interface StatusPageSource {
    /**
     * The page's public address, shown and linked even when the page could not be read.
     */
    pageName: string;
    pageUrl: string;
    read(fetch: Fetch, now: number): Promise<ParsedStatusPage>;
}

class StatusReadError extends Error {
    constructor(readonly reason: AgentProviderStatusFailureReason) {
        super(reason);
    }
}

async function fetchJson(fetch: Fetch, url: string): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
        throw new StatusReadError('network');
    }
    if (!response.ok) {
        // eslint-disable-next-line no-void -- an error page's body is never read
        void response.body?.cancel().catch(() => {});
        throw new StatusReadError('http');
    }
    const chunks: Uint8Array[] = [];
    let end: CappedBodyEnd;
    try {
        end = await readCappedBody(response, MAX_STATUS_PAGE_BYTES, (chunk) => {
            chunks.push(chunk);
        });
    } catch {
        throw new StatusReadError('network');
    }
    // A page past the cap is not a status summary any more; it is reported like any other unexpected shape.
    if (end !== 'end') throw new StatusReadError('invalidResponse');
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
        throw new StatusReadError('invalidResponse');
    }
}

function parsedOrThrow<T>(parsed: T | undefined): T {
    if (!parsed) throw new StatusReadError('invalidResponse');
    return parsed;
}

const CODEX_STATUS_ORIGIN = 'https://status.openai.com/proxy/status.openai.com';

/**
 * The current state decides the read; the history is an addition, so a failed history read only leaves the component
 * without `uptime` and never turns an answered page into an unavailable one.
 */
async function readCodexStatusPage(fetch: Fetch, now: number): Promise<ParsedStatusPage> {
    const historyUrl = new URL(`${CODEX_STATUS_ORIGIN}/component_impacts`);
    const window = { start: now - HISTORY_WINDOW_MS, end: now };
    historyUrl.searchParams.set('start_at', new Date(window.start).toISOString());
    historyUrl.searchParams.set('end_at', new Date(window.end).toISOString());
    let historyFailure: AgentProviderStatusFailureReason | undefined;
    const readHistory = async (): Promise<unknown> => {
        try {
            return await fetchJson(fetch, historyUrl.href);
        } catch (error) {
            historyFailure = error instanceof StatusReadError ? error.reason : 'invalidResponse';
            return undefined;
        }
    };
    const [summary, history] = await Promise.all([
        fetchJson(fetch, CODEX_STATUS_ORIGIN),
        readHistory(),
    ]);
    const { componentIds, ...page } = parsedOrThrow(parseCodexStatusPage(summary));
    const components = page.components.map((component): AgentProviderStatusComponent => {
        const id = componentIds.get(component.name);
        if (id === undefined || history === undefined) return component;
        const uptime = parseIncidentIoHistory(history, id, window);
        historyFailure ??= uptime ? undefined : 'invalidResponse';
        return uptime ? { ...component, uptime } : component;
    });
    return { ...page, components, ...(historyFailure && { historyFailure }) };
}

const STATUS_PAGES: Partial<Record<AgentProvider, StatusPageSource>> = {
    claude: {
        pageName: 'Claude',
        pageUrl: 'https://status.claude.com',
        read: async (fetch) =>
            parsedOrThrow(
                parseClaudeStatusPage(
                    await fetchJson(fetch, 'https://status.claude.com/api/v2/summary.json'),
                ),
            ),
    },
    codex: {
        pageName: 'OpenAI',
        pageUrl: 'https://status.openai.com',
        read: readCodexStatusPage,
    },
};

/**
 * The status-page read an E2E launch uses: never the network. With a fixture directory, a request answers with
 * `<directory>/<hostname>.<last path segment>.json` when that file exists (`status.openai.com.component_impacts.json`
 * for the history feed), else `<directory>/<hostname>.json` (`status.claude.com.json`); without a directory, or for a
 * page with no fixture, every page is unreachable.
 */
export function createE2EStatusPageFetch(directory: string | undefined): Fetch {
    return async (url) => {
        if (!directory) throw new Error('Status pages are offline in E2E');
        const { hostname, pathname } = new URL(url);
        const segment = pathname.split('/').findLast(Boolean);
        let body: string;
        try {
            body = await readFile(join(directory, `${hostname}.${segment}.json`), 'utf8');
        } catch {
            body = await readFile(join(directory, `${hostname}.json`), 'utf8');
        }
        return new Response(body, { headers: { 'content-type': 'application/json' } });
    };
}

interface CachedStatus {
    status: AgentProviderStatus;
    expiresAt: number;
}

/**
 * Public status of the services an Agent CLI talks to, cached per provider. `fetch` is Electron's `net.fetch` in the
 * app, so the system proxy applies exactly as it does in a browser; an E2E launch passes a fetch that never leaves the
 * machine.
 */
export function createAgentProviderStatus(options: {
    fetch: Fetch;
    logger?: () => StructuredLogger | undefined;
    now?: () => number;
}) {
    const now = options.now ?? Date.now;
    const cache = new Map<AgentProvider, CachedStatus>();
    const inFlight = new Map<AgentProvider, Promise<AgentProviderStatus>>();
    /**
     * The last failure reason per provider, so a page that stays down logs once, not on every expiry, and its recovery
     * is recorded as a transition.
     */
    const failing = new Map<AgentProvider, AgentProviderStatusFailureReason>();
    /**
     * The same transition record for the optional uptime history, which fails on its own without failing the page.
     */
    const historyFailing = new Map<AgentProvider, AgentProviderStatusFailureReason>();

    function recordHistoryRead(
        provider: AgentProvider,
        reason: AgentProviderStatusFailureReason | undefined,
    ): void {
        const previous = historyFailing.get(provider);
        if (previous === reason) return;
        const logger = options.logger?.();
        if (reason) {
            historyFailing.set(provider, reason);
            logger?.write('warn', logEventCatalog.externalStatus.providerHistoryFailed, {
                fields: { provider, reason },
            });
        } else if (previous) {
            historyFailing.delete(provider);
            logger?.write('info', logEventCatalog.externalStatus.providerHistoryRecovered, {
                fields: { provider, previousReason: previous },
            });
        }
    }

    async function refresh(
        provider: AgentProvider,
        source: StatusPageSource,
    ): Promise<AgentProviderStatus> {
        const checkedAt = now();
        let status: AgentProviderStatus;
        try {
            const { historyFailure, ...page } = await source.read(options.fetch, checkedAt);
            recordHistoryRead(provider, historyFailure);
            status = {
                ...page,
                provider,
                checkedAt,
                state: 'available',
                status: worstStatus(page.components.map((component) => component.status)),
            };
            const previous = failing.get(provider);
            if (previous) {
                failing.delete(provider);
                options
                    .logger?.()
                    ?.write('info', logEventCatalog.externalStatus.providerStatusRecovered, {
                        fields: { provider, previousReason: previous },
                    });
            }
        } catch (error) {
            const reason = error instanceof StatusReadError ? error.reason : 'invalidResponse';
            status = {
                provider,
                checkedAt,
                pageName: source.pageName,
                pageUrl: source.pageUrl,
                state: 'unavailable',
                reason,
            };
            if (failing.get(provider) !== reason) {
                failing.set(provider, reason);
                options
                    .logger?.()
                    ?.write('warn', logEventCatalog.externalStatus.providerStatusFailed, {
                        fields: { provider, reason },
                    });
            }
        }
        // Validated here so a page that changed shape fails in Main with a reason instead of at the IPC boundary.
        const checked = agentProviderStatusSchema.safeParse(status);
        const result: AgentProviderStatus = checked.success
            ? checked.data
            : {
                  provider,
                  checkedAt,
                  pageName: source.pageName,
                  pageUrl: source.pageUrl,
                  state: 'unavailable',
                  reason: 'invalidResponse',
              };
        cache.set(provider, {
            status: result,
            expiresAt: checkedAt + (result.state === 'available' ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
        });
        return result;
    }

    async function refreshOnce(
        provider: AgentProvider,
        source: StatusPageSource,
    ): Promise<AgentProviderStatus> {
        try {
            return await refresh(provider, source);
        } finally {
            inFlight.delete(provider);
        }
    }

    return async (provider: AgentProvider): Promise<AgentProviderStatus | null> => {
        const source = STATUS_PAGES[provider];
        if (!source) return null;
        const cached = cache.get(provider);
        if (cached && cached.expiresAt > now()) return cached.status;
        let pending = inFlight.get(provider);
        if (!pending) {
            pending = refreshOnce(provider, source);
            inFlight.set(provider, pending);
        }
        return pending;
    };
}
