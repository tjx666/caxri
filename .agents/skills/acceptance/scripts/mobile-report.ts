import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export const mobileDeviceSchema = z.object({
    appId: z.literal('com.caxri.mobile'),
    deviceId: z.string().trim().min(1).max(200),
    platform: z.enum(['android', 'ios']),
});

const mobileEvidenceBindingSchema = z.union([
    z.object({ launchId: z.string().min(1) }),
    z.object({ checkpointId: z.string().min(1) }),
]);

const mobileDeviceReceiptSchema = z
    .object({
        appId: z.literal('com.caxri.mobile'),
        build: z.object({ identity: z.string().min(1), mode: z.string().min(1) }),
        caseId: z.string().min(1),
        cleanup: z.object({
            appData: z.enum(['cleared', 'preserved']),
            desktopProfile: z.string(),
        }),
        device: z.object({
            id: z.string().min(1),
            kind: z.string().min(1),
            platform: z.enum(['android', 'ios']),
        }),
        outcome: z.string().min(1),
        schemaVersion: z.literal(1),
        sourceCommit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
        status: z.enum(['passed', 'failed', 'blocked']),
    })
    .and(mobileEvidenceBindingSchema);

const mobileResultReceiptSchema = z
    .object({
        channel: z.literal('authenticated-encrypted-gateway'),
        delivery: z.object({
            count: z.literal(1),
            destination: z.literal('main-agent-terminal'),
            repeatDisabled: z.literal(true),
            stateAfterReply: z.literal('running'),
        }),
        projectScope: z.literal('allowed-present-denied-absent'),
        schemaVersion: z.literal(1),
        sourceCommit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
        status: z.literal('passed'),
    })
    .and(mobileEvidenceBindingSchema);

const mobileDeviceEvidencePath = (caseId: string): string =>
    `assets/${encodeURIComponent(caseId)}-mobile-device.json`;

const mobileResultEvidencePath = (caseId: string): string =>
    `assets/${encodeURIComponent(caseId)}-result.json`;

/**
 * Binds mobile evidence to the frozen target, report source, and declared isolation identity.
 */
export async function validateMobileEvidence(input: {
    caseId: string;
    device: z.infer<typeof mobileDeviceSchema>;
    directory: string;
    evidencePaths: string[];
    evidenceBinding: z.infer<typeof mobileEvidenceBindingSchema>;
    expectedStatus: z.infer<typeof mobileDeviceReceiptSchema>['status'];
    reportCommit: string | undefined;
}): Promise<void> {
    const deviceEvidence = mobileDeviceEvidencePath(input.caseId);
    if (!input.evidencePaths.includes(deviceEvidence))
        throw new Error(`Case ${input.caseId} must include its mobile device receipt`);
    const rawDeviceReceipt: unknown = JSON.parse(
        await readFile(join(input.directory, deviceEvidence), 'utf8'),
    );
    const deviceReceipt = mobileDeviceReceiptSchema.parse(rawDeviceReceipt);
    if (
        !input.reportCommit ||
        deviceReceipt.caseId !== input.caseId ||
        JSON.stringify(mobileEvidenceBindingSchema.parse(deviceReceipt)) !==
            JSON.stringify(input.evidenceBinding) ||
        deviceReceipt.sourceCommit !== input.reportCommit ||
        deviceReceipt.device.id !== input.device.deviceId ||
        deviceReceipt.device.platform !== input.device.platform ||
        deviceReceipt.status !== input.expectedStatus
    ) {
        throw new Error(
            `Case ${input.caseId} mobile device receipt does not match the frozen plan`,
        );
    }
    const resultEvidence = mobileResultEvidencePath(input.caseId);
    if (!input.evidencePaths.includes(resultEvidence)) return;
    const rawResultReceipt: unknown = JSON.parse(
        await readFile(join(input.directory, resultEvidence), 'utf8'),
    );
    const resultReceipt = mobileResultReceiptSchema.parse(rawResultReceipt);
    if (
        JSON.stringify(mobileEvidenceBindingSchema.parse(resultReceipt)) !==
            JSON.stringify(input.evidenceBinding) ||
        resultReceipt.sourceCommit !== input.reportCommit
    ) {
        throw new Error(`Case ${input.caseId} mobile result receipt is stale`);
    }
}
