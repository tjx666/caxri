import { z } from 'zod';

export const mobileDeviceSchema = z.object({
    appId: z.literal('com.caxri.mobile'),
    deviceId: z.string().trim().min(1).max(200),
    platform: z.enum(['android', 'ios']),
});

export const mobileDeviceReceiptSchema = z.object({
    appId: z.literal('com.caxri.mobile'),
    build: z.object({ identity: z.string().min(1), mode: z.string().min(1) }),
    caseId: z.string().min(1),
    cleanup: z.object({ appData: z.enum(['cleared', 'preserved']), desktopProfile: z.string() }),
    device: z.object({
        id: z.string().min(1),
        kind: z.string().min(1),
        platform: z.enum(['android', 'ios']),
    }),
    outcome: z.string().min(1),
    schemaVersion: z.literal(1),
    status: z.enum(['passed', 'failed', 'blocked']),
});

export const mobileDeviceEvidencePath = (caseId: string): string =>
    `assets/${encodeURIComponent(caseId)}-mobile-device.json`;
