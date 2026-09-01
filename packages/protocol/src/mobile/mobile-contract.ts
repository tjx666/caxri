import { z } from 'zod';

import {
    canceledResultSchema,
    identifierSchema,
    sessionRecordSchema,
    terminalRecordSchema,
} from '../domain/domain.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const noParameters = z.strictObject({}).default({});
export const mobileDeviceIdSchema = z.string().regex(/^device_[0-9a-f]{32}$/u);
export const MOBILE_MAX_PROJECT_GRANTS = 128;
export const MOBILE_SHORT_REPLY_MAX_BYTES = 1_024;
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

export const mobileDashboardResultSchema = z.strictObject({
    sessions: z.array(mobileDashboardSessionSchema).max(64),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
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
