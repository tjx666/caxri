import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * A provider status page component's health, worst last. Both Statuspage (Claude) and incident.io (OpenAI) report this
 * same five-step scale under slightly different names; Main normalizes them.
 */
export const agentProviderServiceStatuses = [
    'operational',
    'maintenance',
    'degraded',
    'partialOutage',
    'majorOutage',
] as const;
const agentProviderServiceStatusSchema = z.enum(agentProviderServiceStatuses);
export type AgentProviderServiceStatus = z.infer<typeof agentProviderServiceStatusSchema>;

/**
 * Why a status page could not be read. `network` covers offline, DNS, proxy, and timeout failures; `http` a non-2xx
 * answer; `invalidResponse` a body that no longer has the shape Main parses, which usually means the page changed.
 */
const agentProviderStatusFailureReasonSchema = z.enum(['network', 'http', 'invalidResponse']);
export type AgentProviderStatusFailureReason = z.infer<
    typeof agentProviderStatusFailureReasonSchema
>;

const statusTextSchema = z.string().max(500);

/**
 * One stretch of time a status page recorded a component as not operational.
 */
const agentProviderStatusImpactSchema = z.strictObject({
    /**
     * Epoch milliseconds.
     */
    startAt: z.number(),
    /**
     * Epoch milliseconds; absent while the impact is still open.
     */
    endAt: z.number().optional(),
    status: agentProviderServiceStatusSchema,
});

/**
 * A component's recent history as its status page publishes it: the page's own uptime figure over the window and the
 * raw impact intervals. Intervals rather than per-day buckets, so the Renderer can split days in the user's time zone.
 */
const agentProviderStatusUptimeSchema = z.strictObject({
    /**
     * Epoch milliseconds the history window starts and ends.
     */
    windowStart: z.number(),
    windowEnd: z.number(),
    /**
     * The page's uptime percentage for the window, when it publishes one.
     */
    percent: z.number().min(0).max(100).optional(),
    /**
     * Epoch milliseconds the page started recording this component; days before it have no data.
     */
    dataAvailableSince: z.number().optional(),
    impacts: z.array(agentProviderStatusImpactSchema).max(1_000),
});

const agentProviderStatusComponentSchema = z.strictObject({
    name: statusTextSchema,
    status: agentProviderServiceStatusSchema,
    /**
     * Present only when the page publishes component history (incident.io) and it could be read.
     */
    uptime: agentProviderStatusUptimeSchema.optional(),
});

const agentProviderStatusIncidentSchema = z.strictObject({
    name: statusTextSchema,
    /**
     * The incident's own phase as the page words it (`investigating`, `identified`, `monitoring`), shown verbatim.
     */
    phase: statusTextSchema,
    /**
     * Worst status the incident put one of the listed components in.
     */
    status: agentProviderServiceStatusSchema,
    /**
     * The affected components among the ones this provider's status reports, by name.
     */
    components: z.array(statusTextSchema).max(32),
    /**
     * Text of the newest update, plain or Markdown as the page published it.
     */
    latestUpdate: z.string().max(4_000).optional(),
    /**
     * Epoch milliseconds of the newest update.
     */
    updatedAt: z.number().optional(),
    url: z.string().max(2_048),
});

const statusPageFields = {
    provider: agentProviderSchema,
    /**
     * The page's own name, such as `OpenAI` or `Claude`.
     */
    pageName: statusTextSchema,
    pageUrl: z.string().max(2_048),
    /**
     * Epoch milliseconds when Main last tried the page, successful or not.
     */
    checkedAt: z.number(),
};

export const agentProviderStatusSchema = z.discriminatedUnion('state', [
    z.strictObject({
        ...statusPageFields,
        state: z.literal('available'),
        /**
         * Worst status among `components`.
         */
        status: agentProviderServiceStatusSchema,
        components: z.array(agentProviderStatusComponentSchema).max(32),
        /**
         * Unresolved incidents touching at least one of `components`, newest first.
         */
        incidents: z.array(agentProviderStatusIncidentSchema).max(16),
    }),
    z.strictObject({
        ...statusPageFields,
        state: z.literal('unavailable'),
        reason: agentProviderStatusFailureReasonSchema,
    }),
]);
export type AgentProviderStatus = z.infer<typeof agentProviderStatusSchema>;
export type AgentProviderStatusIncident = z.infer<typeof agentProviderStatusIncidentSchema>;
export type AgentProviderStatusComponent = z.infer<typeof agentProviderStatusComponentSchema>;
export type AgentProviderStatusUptime = z.infer<typeof agentProviderStatusUptimeSchema>;

export const agentProviderStatusDesktopMethods = {
    /**
     * The provider's public service status (OpenAI's Codex API component, Claude's API and Claude Code components) so a
     * slow or failing Agent can be told apart from a provider incident. Main reads the status page through Chromium's
     * network stack, so the system proxy applies; the Renderer's CSP forbids the request and Server Core's Node `fetch`
     * ignores the system proxy. Null for a provider without a public status page.
     */
    'agentProviderStatus.read': {
        ...commandPolicy('desktop', 'read'),
        params: z.strictObject({ provider: agentProviderSchema }),
        result: agentProviderStatusSchema.nullable(),
    },
} as const satisfies Record<string, MethodSpec>;
