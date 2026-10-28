import { z } from 'zod';

import { MAX_MIHOMO_CONTROLLER_NODES } from '../configuration/environment-monitor-settings.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const publicIpChangedIssueSchema = z.strictObject({
    kind: z.literal('publicIpChanged'),
});

const timeZoneMismatchIssueSchema = z.strictObject({
    kind: z.literal('timeZoneMismatch'),
    expectedTimeZone: z.string().min(1).max(100),
    actualTimeZone: z.string().min(1).max(100),
});

const routeNodeMismatchIssueSchema = z.strictObject({
    kind: z.literal('routeNodeMismatch'),
    domain: z.string().min(1).max(253),
    expectedNode: z.string().min(1).max(160),
    observedChain: z.array(z.string().min(1).max(160)).min(1).max(16),
});

export const environmentMonitorIssueSchema = z.discriminatedUnion('kind', [
    publicIpChangedIssueSchema,
    timeZoneMismatchIssueSchema,
    routeNodeMismatchIssueSchema,
]);

export type EnvironmentMonitorIssue = z.infer<typeof environmentMonitorIssueSchema>;

export const environmentMonitorStateSchema = z.strictObject({
    state: z.enum(['disabled', 'healthy', 'warning']),
    issues: z.array(environmentMonitorIssueSchema).max(34),
    checkedAt: z.number().int().nonnegative().optional(),
    canUseCurrentIp: z.boolean(),
});

export type EnvironmentMonitorState = z.infer<typeof environmentMonitorStateSchema>;

const desktopRead = commandPolicy('desktop', 'read');
const desktopControl = commandPolicy('desktop', 'control');
const noParameters = z.object({}).default({});
const mihomoControllerAccessParameters = z.strictObject({
    endpoint: z.string().min(1).max(4_096),
    secret: z.string().max(4_096).nullable(),
});

/**
 * Desktop-only access to the boot-scoped monitor. Raw public IP values never enter this contract. Controller access is
 * accepted only for bounded node discovery, then revalidated as local-only inside Main.
 */
export const environmentMonitorDesktopMethods = {
    'environmentMonitor.read': {
        ...desktopRead,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
    'environmentMonitor.checkNow': {
        ...desktopControl,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
    'environmentMonitor.useCurrentIp': {
        ...desktopControl,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
    'environmentMonitor.mihomoNodes': {
        ...desktopRead,
        params: mihomoControllerAccessParameters,
        result: z.strictObject({
            nodes: z.array(z.string().min(1).max(160)).max(MAX_MIHOMO_CONTROLLER_NODES),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
