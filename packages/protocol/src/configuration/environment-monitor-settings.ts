import { z } from 'zod';

import type { SettingSpec } from './settings-spec.js';

export const MAX_ENVIRONMENT_MONITOR_DOMAIN_LENGTH = 253;
export const MAX_ENVIRONMENT_MONITOR_NODE_LENGTH = 160;
export const MAX_ENVIRONMENT_MONITOR_ROUTE_ASSERTIONS = 32;
export const MAX_MIHOMO_CONTROLLER_SECRET_LENGTH = 4_096;
export const MAX_MIHOMO_CONTROLLER_NODES = 1_000;

export const DEFAULT_MIHOMO_CONTROLLER_ENDPOINT = 'http://127.0.0.1:9090';

/**
 * An exact host observed in Mihomo's live connection metadata. Active probes are deliberately excluded: monitoring a
 * route must never create traffic to the domain it is meant to observe.
 */
export function normalizeEnvironmentMonitorDomain(value: string): string | undefined {
    const candidate = value.trim().toLowerCase();
    if (!candidate || candidate.length > MAX_ENVIRONMENT_MONITOR_DOMAIN_LENGTH) return undefined;
    if (candidate.includes('/') || candidate.includes('@') || candidate.includes(':'))
        return undefined;
    try {
        const parsed = new URL(`https://${candidate}`);
        if (parsed.hostname !== candidate || parsed.hostname.endsWith('.')) return undefined;
        return parsed.hostname;
    } catch {
        return undefined;
    }
}

/**
 * Limits Controller access to this Mac. Mihomo supports TCP and Unix sockets; remote Controllers are intentionally not
 * accepted because this feature describes the local environment and may carry a Controller secret.
 */
export function normalizeMihomoControllerEndpoint(value: string): string | undefined {
    const candidate = value.trim();
    if (!candidate) return undefined;
    if (candidate.startsWith('unix://')) {
        const socketPath = candidate.slice('unix://'.length);
        return socketPath.startsWith('/') && socketPath.length > 1 && !socketPath.includes('\0')
            ? `unix://${socketPath}`
            : undefined;
    }
    try {
        const parsed = new URL(candidate);
        const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (
            !isLoopback ||
            parsed.protocol !== 'http:' ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            parsed.pathname !== '/'
        )
            return undefined;
        return parsed.href.replace(/\/$/u, '');
    } catch {
        return undefined;
    }
}

export function normalizeEnvironmentMonitorTimeZone(value: string): string | undefined {
    const candidate = value.trim();
    if (!candidate || candidate.length > 100) return undefined;
    try {
        return new Intl.DateTimeFormat('en', { timeZone: candidate }).resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
}

const canonicalEnvironmentMonitorDomainSchema = z
    .string()
    .min(1)
    .max(MAX_ENVIRONMENT_MONITOR_DOMAIN_LENGTH)
    .refine((value) => normalizeEnvironmentMonitorDomain(value) === value, {
        message: 'Expected a canonical exact domain name',
    });

const canonicalMihomoControllerEndpointSchema = z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => normalizeMihomoControllerEndpoint(value) === value, {
        message: 'Expected a canonical loopback HTTP endpoint or absolute Unix socket',
    });

export const environmentMonitorRouteAssertionSchema = z.strictObject({
    domain: canonicalEnvironmentMonitorDomainSchema,
    expectedNode: z.string().min(1).max(MAX_ENVIRONMENT_MONITOR_NODE_LENGTH),
});

export type EnvironmentMonitorRouteAssertion = z.infer<
    typeof environmentMonitorRouteAssertionSchema
>;

export const mihomoControllerAccessSchema = z.strictObject({
    endpoint: z
        .string()
        .min(1)
        .max(4_096)
        .transform((value, context) => {
            const normalized = normalizeMihomoControllerEndpoint(value);
            if (normalized) return normalized;
            context.addIssue({
                code: 'custom',
                message: 'Expected a loopback HTTP endpoint or an absolute Unix socket',
            });
            return z.NEVER;
        })
        .default(DEFAULT_MIHOMO_CONTROLLER_ENDPOINT),
    secret: z
        .string()
        .max(MAX_MIHOMO_CONTROLLER_SECRET_LENGTH)
        .transform((value) => value.trim() || null)
        .nullable()
        .default(null),
});

export type MihomoControllerAccess = z.infer<typeof mihomoControllerAccessSchema>;

function requireUniqueDomains(
    assertions: EnvironmentMonitorRouteAssertion[],
    context: z.RefinementCtx,
): void {
    const seen = new Set<string>();
    for (const [index, assertion] of assertions.entries()) {
        if (seen.has(assertion.domain)) {
            context.addIssue({
                code: 'custom',
                message: 'Each domain can have only one expected node',
                path: [index, 'domain'],
            });
        }
        seen.add(assertion.domain);
    }
}

const canonicalMihomoControllerAccessSchema = z.strictObject({
    endpoint: canonicalMihomoControllerEndpointSchema.default(DEFAULT_MIHOMO_CONTROLLER_ENDPOINT),
    secret: z.string().max(MAX_MIHOMO_CONTROLLER_SECRET_LENGTH).nullable().default(null),
});

export const environmentMonitorMihomoSettingsSchema = canonicalMihomoControllerAccessSchema
    .extend({
        assertions: z
            .array(environmentMonitorRouteAssertionSchema)
            .max(MAX_ENVIRONMENT_MONITOR_ROUTE_ASSERTIONS)
            .superRefine(requireUniqueDomains)
            .default([]),
    })
    .default({
        endpoint: DEFAULT_MIHOMO_CONTROLLER_ENDPOINT,
        secret: null,
        assertions: [],
    });

export type EnvironmentMonitorMihomoSettings = z.infer<
    typeof environmentMonitorMihomoSettingsSchema
>;

const environmentMonitorDomainFileSchema = z
    .string()
    .min(1)
    .max(MAX_ENVIRONMENT_MONITOR_DOMAIN_LENGTH)
    .transform((value, context) => {
        const normalized = normalizeEnvironmentMonitorDomain(value);
        if (normalized) return normalized;
        context.addIssue({ code: 'custom', message: 'Expected an exact domain name' });
        return z.NEVER;
    });

const environmentMonitorNodeFileSchema = z
    .string()
    .trim()
    .min(1)
    .max(MAX_ENVIRONMENT_MONITOR_NODE_LENGTH);

const environmentMonitorRouteAssertionFileSchema = z.strictObject({
    domain: environmentMonitorDomainFileSchema,
    expectedNode: environmentMonitorNodeFileSchema,
});

export const environmentMonitorMihomoSettingsFileSchema = mihomoControllerAccessSchema
    .extend({
        assertions: z
            .array(environmentMonitorRouteAssertionFileSchema)
            .max(MAX_ENVIRONMENT_MONITOR_ROUTE_ASSERTIONS)
            .superRefine(requireUniqueDomains)
            .default([]),
    })
    .default({
        endpoint: DEFAULT_MIHOMO_CONTROLLER_ENDPOINT,
        secret: null,
        assertions: [],
    });

export const expectedEnvironmentTimeZoneSchema = z
    .string()
    .min(1)
    .max(100)
    .refine((value) => normalizeEnvironmentMonitorTimeZone(value) === value, {
        message: 'Expected a canonical IANA time zone',
    })
    .nullable()
    .default(null);

export const expectedEnvironmentTimeZoneFileSchema = z
    .string()
    .max(100)
    .transform((value, context) => {
        const normalized = normalizeEnvironmentMonitorTimeZone(value);
        if (normalized) return normalized;
        context.addIssue({ code: 'custom', message: 'Expected an IANA time zone' });
        return z.NEVER;
    })
    .nullable()
    .default(null);

/**
 * The only default-enabled signal is the public IP. Time-zone and Mihomo route expectations have no meaning until the
 * user explicitly chooses them, so their empty values are their off state.
 */
export const environmentMonitorSettingsSpec = [
    {
        kind: 'boolean',
        key: 'environmentMonitor.publicIpChanges',
        title: 'Public IP changes',
        description:
            'Notify and keep a status bar warning when the public egress IP changes during this launch.',
        category: 'notifications',
        keywords: ['environment', 'network', 'egress', 'internet', 'address'],
        default: true,
    },
    {
        kind: 'complex',
        key: 'environmentMonitor.expectedTimeZone',
        title: 'Expected system time zone',
        description: 'Warn when the system time zone differs from the time zone you select.',
        category: 'notifications',
        keywords: ['environment', 'timezone', 'time zone', 'iana', 'system'],
    },
    {
        kind: 'complex',
        key: 'environmentMonitor.mihomoRoutes',
        title: 'Domain routes through Mihomo',
        description:
            'Observe real Mihomo connections and warn when a configured domain does not use its expected node.',
        category: 'notifications',
        keywords: ['environment', 'mihomo', 'clash', 'proxy', 'route', 'domain', 'node'],
    },
] as const satisfies readonly SettingSpec[];
