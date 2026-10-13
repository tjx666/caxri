import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusFailureReason,
    AgentProviderStatusIncident,
    AgentProviderStatusUptime,
} from '@caxri/protocol';
import { agentProviderServiceStatuses } from '@caxri/protocol';
import { maxBy } from 'es-toolkit';
import { z } from 'zod';

const MAX_UPDATE_LENGTH = 4_000;

export type ParsedStatusPage = Pick<
    Extract<AgentProviderStatus, { state: 'available' }>,
    'components' | 'incidents' | 'pageName' | 'pageUrl'
> & {
    /**
     * Why the optional uptime history could not be read, while the current state still was. Main only logs it; it never
     * reaches the Renderer.
     */
    historyFailure?: AgentProviderStatusFailureReason;
};

const statusRank = new Map(agentProviderServiceStatuses.map((status, index) => [status, index]));

export function worstStatus(
    statuses: Iterable<AgentProviderServiceStatus>,
): AgentProviderServiceStatus {
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

export interface ParsedCodexStatusPage extends ParsedStatusPage {
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
 * was not operational. Intervals overlapping the window are returned whole. Group-level rows (the page's per-group
 * uptime figure) carry `status_page_component_group_id` instead of `component_id`, so `component_id` is optional and a
 * row without one never matches a component instead of rejecting the whole feed.
 */
const incidentIoImpactSchema = z.object({
    component_id: z.string().optional(),
    start_at: z.string(),
    end_at: nullableText,
    status: z.string(),
});
const incidentIoUptimeSchema = z.object({
    component_id: z.string().optional(),
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
