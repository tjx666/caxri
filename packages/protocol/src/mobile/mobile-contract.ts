import { z } from 'zod';

import { agentEndpointRefSchema as agentEndpointReferenceSchema } from '../agent/agent-endpoint-contract.js';
import {
    canceledResultSchema,
    identifierSchema,
    scopedProjectSchema,
    sessionRecordSchema,
    terminalKindSchema,
    terminalRecordSchema,
} from '../domain/domain.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { mobileDeviceRoleSchema } from './device-role.js';

export type { MobileDeviceRole } from './device-role.js';
export { mobileDeviceRoleSchema } from './device-role.js';

const noParameters = z.strictObject({}).default({});
export const mobileDeviceIdSchema = z.string().regex(/^device_[0-9a-f]{32}$/u);
export const MOBILE_MAX_PROJECT_GRANTS = 128;
export const MOBILE_SHORT_REPLY_MAX_BYTES = 1_024;
export const MOBILE_AGENT_SUBMIT_MAX_BYTES = 16 * 1_024;
export const mobileProjectIdsSchema = z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(MOBILE_MAX_PROJECT_GRANTS)
    .refine(
        (projectIds) => new Set(projectIds).size === projectIds.length,
        'Project grants must be unique',
    );

export const mobileDeviceSummarySchema = z.strictObject({
    deviceId: mobileDeviceIdSchema,
    displayName: z.string().trim().min(1).max(100),
    platform: z.enum(['android', 'ios']),
    generation: z.number().int().positive(),
    role: mobileDeviceRoleSchema,
    projectIds: mobileProjectIdsSchema,
    createdAt: z.number().int().positive(),
    lastConnectedAt: z.number().int().positive().optional(),
    revokedAt: z.number().int().positive().optional(),
});

export const mobileAccessStatusSchema = z.strictObject({
    enabled: z.boolean(),
    address: z.ipv4().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    pairedDeviceCount: z.number().int().nonnegative().max(128),
    pendingPairingCount: z.number().int().nonnegative().max(8),
});

export const mobileDashboardSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    displayTitle: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    lastOpenedAt: sessionRecordSchema.shape.lastOpenedAt,
    lastActivityState: sessionRecordSchema.shape.lastActivityState,
    primaryAgentTerminalId: identifierSchema.optional(),
    primaryAgentEndpoint: agentEndpointReferenceSchema.optional(),
    attentionEpoch: sessionRecordSchema.shape.attentionEpoch,
    hasUnread: sessionRecordSchema.shape.hasUnread,
    primaryTerminal: terminalRecordSchema
        .pick({
            id: true,
            sessionId: true,
            kind: true,
            provider: true,
            lastProcessState: true,
            failureReason: true,
        })
        .optional(),
});

const mobileProjectSummarySchema = scopedProjectSchema.extend({
    lastActivityAt: z.number().int().nonnegative().optional(),
});

export const mobileDashboardResultSchema = z.strictObject({
    hostDisplayName: z.string().trim().min(1).max(100),
    deviceRole: z.enum(['view', 'reply', 'control']).nullable(),
    projects: z.array(mobileProjectSummarySchema).max(MOBILE_MAX_PROJECT_GRANTS),
    sessions: z.array(mobileDashboardSessionSchema).max(64),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
});

export const mobileSessionCreateResultSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema.optional(),
    launchError: z
        .strictObject({
            code: z.literal('TERMINAL_START_FAILED'),
            message: z.string().min(1).max(256),
        })
        .optional(),
});

export const mobileAgentSubmitParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    endpoint: agentEndpointReferenceSchema,
    clientMutationId: identifierSchema,
    text: z
        .string()
        .min(1)
        .refine(
            (value) =>
                value.trim().length > 0 &&
                new TextEncoder().encode(value).length <= MOBILE_AGENT_SUBMIT_MAX_BYTES &&
                ![...value].some((character) => {
                    const code = character.codePointAt(0)!;
                    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
                }),
            'Mobile Agent input must be bounded multiline text without control characters',
        ),
});

export const mobileAgentSubmitResultSchema = z.strictObject({
    terminalId: identifierSchema,
    outcome: z.enum(['accepted', 'unknown']),
});

const mobileAgentAvailabilitySchema = z.strictObject({
    kind: terminalKindSchema,
    available: z.boolean(),
    reason: z.string().min(1).max(200).optional(),
});
const mobileAgentAvailabilityResultSchema = z.strictObject({
    agents: z.array(mobileAgentAvailabilitySchema).length(4),
});

export const mobileMethods = {
    'mobile.access.status': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.access.enable': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.access.disable': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.pairing.create': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ projectIds: mobileProjectIdsSchema }),
        result: z.strictObject({
            pairingLink: z.string().min(1).max(2_048),
            expiresAt: z.number().int().positive(),
        }),
    },
    'mobile.device.list': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: z.strictObject({ devices: z.array(mobileDeviceSummarySchema).max(128) }),
    },
    'mobile.dashboard': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: noParameters,
        result: mobileDashboardResultSchema,
    },
    'mobile.session.show': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ session: mobileDashboardSessionSchema }),
    },
    'mobile.agent.availability': {
        ...commandPolicy('server', 'read', ['projects.read']),
        params: z.strictObject({ projectId: identifierSchema }),
        result: mobileAgentAvailabilityResultSchema,
    },
    'mobile.agent.submit': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: mobileAgentSubmitParametersSchema,
        result: mobileAgentSubmitResultSchema,
    },
    'mobile.session.create': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
        }),
        result: mobileSessionCreateResultSchema,
    },
    'mobile.terminal.takeOver': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
            cols: z.number().int().min(2).max(1_000),
            rows: z.number().int().min(1).max(1_000),
        }),
        result: z.strictObject({ expiresAt: z.number().int().positive() }),
    },
    'mobile.terminal.release': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
        }),
        result: z.null(),
    },
    'mobile.terminal.input': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
            data: z
                .string()
                .min(1)
                .refine(
                    (data) => new TextEncoder().encode(data).length <= 8 * 1_024,
                    'Mobile Terminal input must be at most 8 KiB',
                ),
        }),
        result: z.null(),
    },
    'mobile.device.revoke': {
        ...commandPolicy('desktop', 'control'),
        params: z.strictObject({ deviceId: mobileDeviceIdSchema }),
        result: z.union([canceledResultSchema, mobileDeviceSummarySchema]),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Main may apply a revoke only after its native confirmation. Binding the expected generation prevents a device that
 * changed while the dialog was open from inheriting stale approval.
 */
export const mobileInternalMethods = {
    'mobile.agent.availabilityInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ projectId: identifierSchema, principal: principalSchema }),
        result: mobileMethods['mobile.agent.availability'].result,
    },
    'mobile.agent.submitInternal': {
        ...commandPolicy('server', 'control'),
        params: mobileAgentSubmitParametersSchema.extend({ principal: principalSchema }),
        result: mobileAgentSubmitResultSchema,
    },
    'mobile.session.createForPrincipal': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
            principal: principalSchema,
        }),
        result: mobileSessionCreateResultSchema,
    },
    'mobile.device.revoke.apply': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            deviceId: mobileDeviceIdSchema,
            expectedGeneration: z.number().int().positive(),
        }),
        result: mobileDeviceSummarySchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileAccessStatus = z.infer<typeof mobileAccessStatusSchema>;
export type MobileDashboardResult = z.infer<typeof mobileDashboardResultSchema>;
export type MobileDeviceSummary = z.infer<typeof mobileDeviceSummarySchema>;
