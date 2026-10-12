import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentProvider,
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusComponent,
    AgentProviderStatusFailureReason,
    AgentProviderStatusIncident,
    AgentProviderStatusUptime,
} from '@caxri/protocol';
import { agentProviderServiceStatuses, agentProviderStatusSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { maxBy } from 'es-toolkit';
import { z } from 'zod';

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const FETCH_TIMEOUT_MS = 10_000;
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
const MAX_UPDATE_LENGTH = 4_000;
/**
 * The history window status.openai.com itself draws (`history_window_days`).
 */
const HISTORY_WINDOW_MS = 90 * 86_400_000;

type ParsedStatusPage = Pick<
    Extract<AgentProviderStatus, { state: 'available' }>,
    'components' | 'incidents' | 'pageName' | 'pageUrl'
>;

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

const statusRank = new Map(agentProviderServiceStatuses.map((status, index) => [status, index]));

function worstStatus(statuses: Iterable<AgentProviderServiceStatus>): AgentProviderServiceStatus {
    let worst: AgentProviderServiceStatus = 'operational';
    for (const status of statuses)
        if ((statusRank.get(status) ?? 0) > (statusRank.get(worst) ?? 0)) worst = status;
    return worst;
}

/**
 * Statuspage and incident.io name the same scale differently (`major_outage` vs `full_outage`). An unknown value still
 * means "not operational", so it reads as degraded rather than being dropped.
 */
function serviceStatus(value: string): AgentProviderServiceStatus {
    switch (value) {
        case 'operational':
            return 'operational';
        case 'under_maintenance':
            return 'maintenance';
        case 'partial_outage':
            return 'partialOutage';
        case 'major_outage':
        case 'full_outage':
            return 'majorOutage';
        default:
            return 'degraded';
    }
}

function epochMs(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
}

function clip(text: string | null | undefined): string | undefined {
    const trimmed = text?.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_UPDATE_LENGTH
        ? `${trimmed.slice(0, MAX_UPDATE_LENGTH - 1)}…`
        : trimmed;
}

/**
 * https://status.claude.com/api: the Statuspage v2 summary.
 */
const nullableText = z.string().nullish();
const statuspageComponentSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
});
const statuspageComponentReferenceSchema = z.object({ id: z.string() });
const statuspageUpdateSchema = z.object({ body: nullableText, updated_at: nullableText });
const statuspageIncidentSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    impact: nullableText,
    updated_at: nullableText,
    components: z.array(statuspageComponentReferenceSchema).default([]),
    incident_updates: z.array(statuspageUpdateSchema).default([]),
});
const statuspagePageSchema = z.object({ name: z.string(), url: z.string() });
const statuspageSummarySchema = z.object({
    page: statuspagePageSchema,
    components: z.array(statuspageComponentSchema),
    incidents: z.array(statuspageIncidentSchema),
});

const statuspageImpactStatus: Record<string, AgentProviderServiceStatus> = {
    minor: 'degraded',
    major: 'partialOutage',
    critical: 'majorOutage',
};

/**
 * Only the components an Agent CLI depends on: `claude.ai`, the Console, and Cowork going down does not slow Claude
 * Code. Matched by name prefix because the API component's name carries its host (`Claude API (api.anthropic.com)`).
 */
const CLAUDE_COMPONENT_PREFIXES = ['Claude API', 'Claude Code'];

export function parseClaudeStatusPage(body: unknown): ParsedStatusPage | undefined {
    const parsed = statuspageSummarySchema.safeParse(body);
    if (!parsed.success) return undefined;
    const { page, components, incidents } = parsed.data;
    const selected = components.filter((component) =>
        CLAUDE_COMPONENT_PREFIXES.some((prefix) => component.name.startsWith(prefix)),
    );
    if (selected.length === 0) return undefined;
    const byId = new Map(
        selected.map((component) => [
            component.id,
            { name: component.name, status: serviceStatus(component.status) },
        ]),
    );
    const pageUrl = page.url.replace(/\/+$/u, '');
    return {
        pageName: page.name,
        pageUrl,
        components: byId.values().toArray(),
        incidents: incidents
            .filter((incident) => incident.status !== 'resolved')
            .flatMap((incident): AgentProviderStatusIncident[] => {
                const affected = incident.components
                    .map((component) => byId.get(component.id))
                    .filter((component) => component !== undefined);
                if (affected.length === 0) return [];
                const latest = incident.incident_updates.at(0);
                const fromComponents = worstStatus(affected.map((component) => component.status));
                return [
                    {
                        name: incident.name,
                        phase: incident.status,
                        status:
                            fromComponents === 'operational'
                                ? (statuspageImpactStatus[incident.impact ?? ''] ?? 'operational')
                                : fromComponents,
                        components: affected.map((component) => component.name),
                        latestUpdate: clip(latest?.body),
                        updatedAt: epochMs(latest?.updated_at ?? incident.updated_at),
                        url: `${pageUrl}/incidents/${encodeURIComponent(incident.id)}`,
                    },
                ];
            }),
    };
}

/**
 * The incident.io page's own data feed. OpenAI's Statuspage-compatible `api/v2/summary.json` truncates its component
 * list before the Codex group, so the Codex components are only reachable here.
 */
const incidentIoGroupComponentSchema = z.object({
    component_id: z.string(),
    name: z.string(),
    hidden: z.boolean().optional(),
});
const incidentIoGroupSchema = z.object({
    name: z.string(),
    components: z.array(incidentIoGroupComponentSchema),
});
const incidentIoStructureItemSchema = z.object({ group: incidentIoGroupSchema.optional() });
const incidentIoStructureSchema = z.object({ items: z.array(incidentIoStructureItemSchema) });
const incidentIoComponentStatusSchema = z.object({ component_id: z.string(), status: z.string() });
const incidentIoMessageSchema = z.object({ markdown: nullableText });
const incidentIoUpdateSchema = z.object({
    published_at: nullableText,
    message_string: nullableText,
    message: incidentIoMessageSchema.nullish(),
});
const incidentIoIncidentSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    affected_components: z.array(incidentIoComponentStatusSchema).default([]),
    updates: z.array(incidentIoUpdateSchema).default([]),
});
const incidentIoPageSchema = z.object({
    name: z.string(),
    public_url: z.string(),
    structure: incidentIoStructureSchema,
    affected_components: z.array(incidentIoComponentStatusSchema).default([]),
    ongoing_incidents: z.array(incidentIoIncidentSchema).default([]),
});
const incidentIoSummarySchema = z.object({ summary: incidentIoPageSchema });

const CODEX_GROUP_NAME = 'Codex';
/**
 * The only Codex component the Codex CLI depends on: Codex Web, the VS Code extension, and the CLI's own row going down
 * does not slow a Codex Agent the way its API does.
 */
const CODEX_COMPONENT_NAME = 'Codex API';

interface ParsedCodexStatusPage extends ParsedStatusPage {
    /**
     * Incident.io component id per listed component name, so the history feed can be matched to it.
     */
    componentIds: Map<string, string>;
}

export function parseCodexStatusPage(body: unknown): ParsedCodexStatusPage | undefined {
    const parsed = incidentIoSummarySchema.safeParse(body);
    if (!parsed.success) return undefined;
    const summary = parsed.data.summary;
    const group = summary.structure.items.find(
        (item) => item.group?.name === CODEX_GROUP_NAME,
    )?.group;
    const visible =
        group?.components.filter(
            (component) => !component.hidden && component.name === CODEX_COMPONENT_NAME,
        ) ?? [];
    if (visible.length === 0) return undefined;
    // The feed lists only the components that are not operational; every other component is operational.
    const affected = new Map(
        summary.affected_components.map((entry) => [entry.component_id, entry.status]),
    );
    const byId = new Map(
        visible.map((component) => [
            component.component_id,
            {
                name: component.name,
                status: serviceStatus(affected.get(component.component_id) ?? 'operational'),
            },
        ]),
    );
    const pageUrl = summary.public_url.replace(/\/+$/u, '');
    return {
        pageName: summary.name,
        pageUrl,
        components: byId.values().toArray(),
        componentIds: new Map(visible.map((component) => [component.name, component.component_id])),
        incidents: summary.ongoing_incidents.flatMap((incident): AgentProviderStatusIncident[] => {
            const touched = incident.affected_components.filter((entry) =>
                byId.has(entry.component_id),
            );
            if (touched.length === 0) return [];
            // incident.io lists updates oldest first, unlike Statuspage, so pick the newest by time.
            const latest = maxBy(incident.updates, (update) => epochMs(update.published_at) ?? 0);
            return [
                {
                    name: incident.name,
                    phase: incident.status,
                    status: worstStatus(touched.map((entry) => serviceStatus(entry.status))),
                    components: touched.map((entry) => byId.get(entry.component_id)!.name),
                    latestUpdate: clip(latest?.message?.markdown ?? latest?.message_string),
                    updatedAt: epochMs(latest?.published_at),
                    url: `${pageUrl}/incidents/${encodeURIComponent(incident.id)}`,
                },
            ];
        }),
    };
}

/**
 * The incident.io page's history feed: every component's uptime over the requested window and each interval a component
 * was not operational. Intervals overlapping the window are returned whole.
 */
const incidentIoImpactSchema = z.object({
    component_id: z.string(),
    start_at: z.string(),
    end_at: nullableText,
    status: z.string(),
});
const incidentIoUptimeSchema = z.object({
    component_id: z.string(),
    uptime: nullableText,
    data_available_since: nullableText,
});
const incidentIoHistorySchema = z.object({
    component_impacts: z.array(incidentIoImpactSchema),
    component_uptimes: z.array(incidentIoUptimeSchema).default([]),
});

export function parseIncidentIoHistory(
    body: unknown,
    componentId: string,
    window: { start: number; end: number },
): AgentProviderStatusUptime | undefined {
    const parsed = incidentIoHistorySchema.safeParse(body);
    if (!parsed.success) return undefined;
    const { component_impacts: impacts, component_uptimes: uptimes } = parsed.data;
    const uptime = uptimes.find((entry) => entry.component_id === componentId);
    const percent = uptime?.uptime ? Number(uptime.uptime) : NaN;
    const dataAvailableSince = epochMs(uptime?.data_available_since);
    return {
        windowStart: window.start,
        windowEnd: window.end,
        ...(Number.isFinite(percent) && percent >= 0 && percent <= 100 && { percent }),
        ...(dataAvailableSince !== undefined && { dataAvailableSince }),
        impacts: impacts.flatMap((impact) => {
            if (impact.component_id !== componentId) return [];
            const startAt = epochMs(impact.start_at);
            if (startAt === undefined) return [];
            const endAt = epochMs(impact.end_at);
            return [
                {
                    startAt,
                    ...(endAt !== undefined && { endAt }),
                    status: serviceStatus(impact.status),
                },
            ];
        }),
    };
}

async function fetchJson(fetch: Fetch, url: string): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
        throw new StatusReadError('network');
    }
    if (!response.ok) throw new StatusReadError('http');
    try {
        return await response.json();
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
    const readHistory = async (): Promise<unknown> => {
        try {
            return await fetchJson(fetch, historyUrl.href);
        } catch {
            return undefined;
        }
    };
    const [summary, history] = await Promise.all([
        fetchJson(fetch, CODEX_STATUS_ORIGIN),
        readHistory(),
    ]);
    const { componentIds, ...page } = parsedOrThrow(parseCodexStatusPage(summary));
    return {
        ...page,
        components: page.components.map((component): AgentProviderStatusComponent => {
            const id = componentIds.get(component.name);
            const uptime =
                id === undefined || history === undefined
                    ? undefined
                    : parseIncidentIoHistory(history, id, window);
            return uptime ? { ...component, uptime } : component;
        }),
    };
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

    async function refresh(
        provider: AgentProvider,
        source: StatusPageSource,
    ): Promise<AgentProviderStatus> {
        const checkedAt = now();
        let status: AgentProviderStatus;
        try {
            const page = await source.read(options.fetch, checkedAt);
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
