import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { z } from 'zod';

import { assertDecodablePng } from './png-integrity';

export const mobileDeviceSchema = z.object({
    appId: z.literal('com.caxri.mobile'),
    deviceId: z.string().trim().min(1).max(200),
    platform: z.enum(['android', 'ios']),
});

const mobileEvidenceBindingSchema = z.union([
    z.object({ launchId: z.string().min(1) }),
    z.object({ checkpointId: z.string().min(1) }),
]);

const mobileArtifactSchema = z.object({
    path: z.string().startsWith('assets/'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    source: z.enum(['android-framebuffer', 'ios-simulator-framebuffer']),
    type: z.enum(['screenshot', 'video']),
});

export const mobileDeviceReceiptSchema = z
    .object({
        appId: z.literal('com.caxri.mobile'),
        artifacts: z.array(mobileArtifactSchema),
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

const SCREENSHOT_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.webm']);

function mobileMediaType(path: string): 'screenshot' | 'video' | undefined {
    const extension = extname(path).toLowerCase();
    if (SCREENSHOT_EXTENSIONS.has(extension)) return 'screenshot';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return undefined;
}

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest('hex');
}

async function validateMobileArtifacts(input: {
    artifacts: Array<z.infer<typeof mobileArtifactSchema>>;
    directory: string;
    evidencePaths: string[];
    platform: z.infer<typeof mobileDeviceSchema>['platform'];
    caseId: string;
}): Promise<void> {
    const mediaEvidence = input.evidencePaths.flatMap((path) => {
        const type = mobileMediaType(path);
        return type ? [{ path, type }] : [];
    });
    const expectedSource =
        input.platform === 'android' ? 'android-framebuffer' : 'ios-simulator-framebuffer';
    const artifactsByPath = new Map(input.artifacts.map((artifact) => [artifact.path, artifact]));
    if (
        mediaEvidence.length !== input.artifacts.length ||
        artifactsByPath.size !== input.artifacts.length
    ) {
        throw new Error(`Case ${input.caseId} must bind mobile media evidence to device captures`);
    }
    for (const evidence of mediaEvidence) {
        const artifact = artifactsByPath.get(evidence.path);
        if (
            !artifact ||
            artifact.type !== evidence.type ||
            artifact.source !== expectedSource ||
            // Sequential hashing keeps failures in frozen evidence order and bounds large recordings.
            // eslint-disable-next-line no-await-in-loop
            artifact.sha256 !== (await sha256(join(input.directory, evidence.path)))
        ) {
            throw new Error(`Case ${input.caseId} mobile media evidence is not device-bound`);
        }
        if (evidence.type === 'screenshot') {
            if (extname(evidence.path).toLowerCase() !== '.png') {
                throw new Error(
                    `Case ${input.caseId} mobile screenshots must be PNG framebuffer captures`,
                );
            }
            // Sequential reads preserve the same evidence-order failure contract as the hash check above.
            // eslint-disable-next-line no-await-in-loop
            await assertDecodablePng(await readFile(join(input.directory, evidence.path)));
        }
    }
}

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
    await validateMobileArtifacts({
        artifacts: deviceReceipt.artifacts,
        caseId: input.caseId,
        directory: input.directory,
        evidencePaths: input.evidencePaths,
        platform: input.device.platform,
    });
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
