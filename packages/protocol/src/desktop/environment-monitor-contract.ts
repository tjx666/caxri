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

const environmentMonitorIssueSchema = z.discriminatedUnion('kind', [
    publicIpChangedIssueSchema,
    timeZoneMismatchIssueSchema,
    routeNodeMismatchIssueSchema,
]);

export type EnvironmentMonitorIssue = z.infer<typeof environmentMonitorIssueSchema>;

const environmentMonitorIpProfileSignalsSchema = z.strictObject({
    anonymous: z.boolean().optional(),
    compromised: z.boolean().optional(),
    hosting: z.boolean().optional(),
    proxy: z.boolean().optional(),
    scraper: z.boolean().optional(),
    tor: z.boolean().optional(),
    vpn: z.boolean().optional(),
});

const environmentMonitorIpProfileAvailableSchema = z.strictObject({
    status: z.literal('available'),
    source: z.literal('checkip.me'),
    checkedAt: z.number().int().nonnegative(),
    country: z.string().min(1).max(100).optional(),
    countryCode: z.string().min(2).max(3).optional(),
    region: z.string().min(1).max(160).optional(),
    city: z.string().min(1).max(160).optional(),
    asn: z.string().min(1).max(32).optional(),
    isp: z.string().min(1).max(200).optional(),
    organization: z.string().min(1).max(200).optional(),
    networkType: z.string().min(1).max(100).optional(),
    operator: z.string().min(1).max(200).optional(),
    riskScore: z.number().min(0).max(100).optional(),
    signals: environmentMonitorIpProfileSignalsSchema,
});

const environmentMonitorIpProfileUnavailableSchema = z.strictObject({
    status: z.literal('unavailable'),
    source: z.literal('checkip.me'),
    checkedAt: z.number().int().nonnegative(),
});

export const environmentMonitorIpProfileSchema = z.discriminatedUnion('status', [
    environmentMonitorIpProfileAvailableSchema,
    environmentMonitorIpProfileUnavailableSchema,
]);

export type EnvironmentMonitorIpProfile = z.infer<typeof environmentMonitorIpProfileSchema>;

const environmentMonitorIpObservationSchema = z.strictObject({
    address: z.union([z.ipv4(), z.ipv6()]),
    family: z.union([z.literal(4), z.literal(6)]),
    observedAt: z.number().int().nonnegative(),
    profile: environmentMonitorIpProfileSchema,
});

const environmentMonitorMihomoRouteObservationSchema = z.strictObject({
    domain: z.string().min(1).max(253),
    expectedNode: z.string().min(1).max(160),
    observedChain: z.array(z.string().min(1).max(160)).max(16),
    status: z.enum(['matched', 'mismatch', 'unobserved']),
});

const environmentMonitorStateSchema = z.strictObject({
    state: z.enum(['disabled', 'healthy', 'warning']),
    issues: z.array(environmentMonitorIssueSchema).max(34),
    checkedAt: z.number().int().nonnegative().optional(),
    canUseCurrentIp: z.boolean(),
    publicIp: z
        .strictObject({
            baseline: environmentMonitorIpObservationSchema,
            current: environmentMonitorIpObservationSchema,
        })
        .optional(),
    timeZone: z.strictObject({
        actual: z.string().min(1).max(100),
        expected: z.string().min(1).max(100).nullable(),
    }),
    mihomo: z.strictObject({
        status: z.enum(['off', 'available', 'unavailable']),
        routes: z.array(environmentMonitorMihomoRouteObservationSchema).max(32),
    }),
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
 * Desktop-only access to the boot-scoped monitor. Public exit details cross only this local, transient contract for the
 * Environment page; they are never persisted or written to diagnostics. Controller access is accepted only for bounded
 * node discovery, then revalidated as local-only inside Main.
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
