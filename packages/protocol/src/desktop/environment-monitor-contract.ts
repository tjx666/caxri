import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

export const environmentMonitorIssueKinds = [
    'publicIpChanged',
    'locationChanged',
    'proxyRouteChanged',
    'proxyUnavailable',
    'timeZoneMismatch',
    'checkUnavailable',
] as const;
export const environmentMonitorIssueKindSchema = z.enum(environmentMonitorIssueKinds);
export type EnvironmentMonitorIssueKind = z.infer<typeof environmentMonitorIssueKindSchema>;

export const environmentMonitorProxyModes = ['direct', 'proxy', 'mixed', 'unknown'] as const;
export const environmentMonitorProxyModeSchema = z.enum(environmentMonitorProxyModes);
export type EnvironmentMonitorProxyMode = z.infer<typeof environmentMonitorProxyModeSchema>;

export const environmentMonitorDetailsSchema = z.strictObject({
    countryCode: z
        .string()
        .regex(/^[A-Z]{2}$/u)
        .optional(),
    region: z.string().min(1).max(160).optional(),
    network: z.string().min(1).max(160).optional(),
    egressTimeZone: z.string().min(1).max(64).optional(),
    systemTimeZone: z.string().min(1).max(64).optional(),
    proxyMode: environmentMonitorProxyModeSchema.optional(),
});
export type EnvironmentMonitorDetails = z.infer<typeof environmentMonitorDetailsSchema>;

export const environmentMonitorStateSchema = z.strictObject({
    state: z.enum(['disabled', 'checking', 'healthy', 'warning', 'unavailable']),
    issues: z.array(environmentMonitorIssueKindSchema).max(environmentMonitorIssueKinds.length),
    checkedAt: z.number().int().nonnegative().optional(),
    lastSuccessfulAt: z.number().int().nonnegative().optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    canAcceptBaseline: z.boolean(),
    details: environmentMonitorDetailsSchema.optional(),
});
export type EnvironmentMonitorState = z.infer<typeof environmentMonitorStateSchema>;

const desktopRead = commandPolicy('desktop', 'read');
const desktopControl = commandPolicy('desktop', 'control');
const noParameters = z.object({}).default({});

/**
 * Desktop-only, boot-scoped monitoring of explicitly selected local network signals. Raw public IP and proxy addresses
 * remain inside Main and never enter this contract.
 */
export const environmentMonitorDesktopMethods = {
    'environmentMonitor.read': {
        ...desktopRead,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
    'environmentMonitor.refresh': {
        ...desktopControl,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
    'environmentMonitor.acceptBaseline': {
        ...desktopControl,
        params: noParameters,
        result: environmentMonitorStateSchema,
    },
} as const satisfies Record<string, MethodSpec>;
