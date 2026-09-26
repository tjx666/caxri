import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { z } from 'zod';

import type { StateIsolation } from './case-lifecycle';
import { caseLifecycleReceiptSchema, lifecycleEvidencePath } from './case-lifecycle';
import { assertDecodablePng } from './png-integrity';
import type { BlockedReason } from './report-blocked-reason';
import { errorCode } from './report-paths';

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

const desktopArtifactSchema = z.object({
    path: z.string().startsWith('assets/'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    source: z.literal('isolated-desktop-renderer'),
    type: z.enum(['screenshot', 'video']),
});

const desktopCaptureReceiptSchema = z.object({
    appId: z.literal('com.caxri.mobile'),
    artifacts: z.array(desktopArtifactSchema).min(2).max(3),
    caseId: z.string().min(1),
    cleanup: z.object({ desktopProfile: z.literal('removed') }),
    desktop: z.object({
        pid: z.number().int().positive(),
        processStartedAt: z.string().min(1),
        profileIdentity: z.string().regex(/^[0-9a-f]{64}$/u),
        targetId: z.string().min(1),
    }),
    launchId: z.string().min(1),
    recording: z
        .object({
            actualSampleCount: z.number().int().min(2),
            durationMs: z.number().int().min(3_000).max(180_000),
            endedAt: z.iso.datetime(),
            maxSampleGapMs: z.number().int().nonnegative().max(1_500),
            sampleCount: z.number().int().positive(),
            sampleRate: z.literal(2),
            startedAt: z.iso.datetime(),
        })
        .optional(),
    schemaVersion: z.literal(1),
    selectedSessionIdentity: z.string().regex(/^[0-9a-f]{64}$/u),
    serial: z.string().min(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/iu),
});

type MediaSource = z.infer<typeof mobileArtifactSchema>['source'] | 'isolated-desktop-renderer';
interface CitedEvidence {
    path: string;
    source?: MediaSource;
}

export const mobileDeviceReceiptSchema = z
    .object({
        appId: z.literal('com.caxri.mobile'),
        artifacts: z.array(mobileArtifactSchema),
        build: z.object({ identity: z.string().min(1), mode: z.string().min(1) }),
        caseId: z.string().min(1),
        cleanup: z.object({
            appData: z.enum(['cleared', 'preserved']),
            desktopProfile: z.string(),
            fixtureIme: z.enum(['pending', 'restored']).optional(),
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
 * The device adapter writes this receipt the first time it reaches the selected target, so its absence is how a
 * `blocked` mobile case proves it never got there — the same rule the launch, preflight, and Agent fixture receipts
 * follow in `report.ts`. Once it exists the case did reach the device and owes the full check.
 */
async function hasMobileDeviceReceipt(directory: string, caseId: string): Promise<boolean> {
    try {
        await readFile(join(directory, mobileDeviceEvidencePath(caseId)), 'utf8');
        return true;
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

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
    evidence: CitedEvidence[];
    platform: z.infer<typeof mobileDeviceSchema>['platform'];
    caseId: string;
    desktopPaths: Set<string>;
}): Promise<void> {
    const mediaEvidence = input.evidence.flatMap(({ path, source }) => {
        const type = mobileMediaType(path);
        return type && !input.desktopPaths.has(path) ? [{ path, source, type }] : [];
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
            (evidence.source !== undefined && evidence.source !== artifact.source) ||
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

async function validateDesktopCapture(input: {
    caseId: string;
    deviceId: string;
    directory: string;
    evidenceBinding: z.infer<typeof mobileEvidenceBindingSchema>;
    evidence: CitedEvidence[];
    reportCommit: string | undefined;
}): Promise<{ desktopPaths: Set<string>; staticVideo?: { durationMs: number; path: string } }> {
    const prefix = `assets/${encodeURIComponent(input.caseId)}-desktop-`;
    const receiptPath = `assets/${encodeURIComponent(input.caseId)}-desktop-capture.json`;
    const videoPath = `assets/${encodeURIComponent(input.caseId)}-desktop.mp4`;
    const screenshotPaths = [`${prefix}before.png`, `${prefix}after.png`];
    const evidencePaths = new Set(input.evidence.map(({ path }) => path));
    let rawReceipt: string;
    try {
        rawReceipt = await readFile(join(input.directory, receiptPath), 'utf8');
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        /**
         * A mobile scenario may mention Desktop in its name while capturing the phone framebuffer. Canonical Desktop
         * paths and explicit Desktop provenance still require their receipt; mobile media keeps its device/hash gate.
         */
        const requiresDesktopReceipt = input.evidence.some(
            ({ path, source }) =>
                screenshotPaths.includes(path) ||
                path === videoPath ||
                source === 'isolated-desktop-renderer' ||
                (path.startsWith(prefix) &&
                    source !== 'android-framebuffer' &&
                    source !== 'ios-simulator-framebuffer'),
        );
        if (requiresDesktopReceipt) {
            throw new Error(
                `Case ${input.caseId} desktop media requires a Desktop capture receipt`,
                {
                    cause: error,
                },
            );
        }
        return { desktopPaths: new Set() };
    }
    if (!evidencePaths.has(receiptPath)) {
        throw new Error(`Case ${input.caseId} must cite its Desktop capture receipt`);
    }
    const receipt = desktopCaptureReceiptSchema.parse(JSON.parse(rawReceipt) as unknown);
    const expectedPaths = receipt.recording ? [...screenshotPaths, videoPath] : screenshotPaths;
    if (
        receipt.artifacts.length !== expectedPaths.length ||
        (receipt.recording !== undefined && input.caseId !== 'MOB-E2E-01')
    ) {
        throw new Error(`Case ${input.caseId} Desktop capture artifact set is invalid`);
    }
    if (receipt.recording) {
        const elapsed =
            Date.parse(receipt.recording.endedAt) - Date.parse(receipt.recording.startedAt);
        if (
            elapsed !== receipt.recording.durationMs ||
            receipt.recording.sampleCount !== Math.ceil(elapsed / 500)
        ) {
            throw new Error(`Case ${input.caseId} Desktop recording timeline is invalid`);
        }
    }
    if (
        !input.reportCommit ||
        !('launchId' in input.evidenceBinding) ||
        receipt.caseId !== input.caseId ||
        receipt.sourceCommit !== input.reportCommit ||
        receipt.launchId !== input.evidenceBinding.launchId ||
        receipt.serial !== input.deviceId ||
        receipt.artifacts.some(
            (artifact, index) =>
                artifact.path !== expectedPaths[index] ||
                artifact.type !== (index === 2 ? 'video' : 'screenshot') ||
                !evidencePaths.has(artifact.path) ||
                input.evidence.find(({ path }) => path === artifact.path)?.source !==
                    'isolated-desktop-renderer',
        )
    ) {
        throw new Error(`Case ${input.caseId} Desktop capture does not match the selected launch`);
    }
    for (const artifact of receipt.artifacts) {
        // Sequential validation preserves the frozen before/after failure order.

        const path = join(input.directory, artifact.path);
        // eslint-disable-next-line no-await-in-loop
        if (artifact.sha256 !== (await sha256(path))) {
            throw new Error(`Case ${input.caseId} Desktop capture media hash does not match`);
        }
        if (artifact.type === 'screenshot') {
            // eslint-disable-next-line no-await-in-loop
            await assertDecodablePng(await readFile(path));
        }
    }
    return {
        desktopPaths: new Set(expectedPaths),
        ...(receipt.recording && {
            staticVideo: { durationMs: receipt.recording.durationMs, path: videoPath },
        }),
    };
}

/**
 * Binds mobile evidence to the frozen target, report source, and declared isolation identity.
 */
interface ValidatedMobileMedia {
    longAndroidVideos: Set<string>;
    staticDesktopVideos: Map<string, number>;
}

const emptyValidatedMedia = (): ValidatedMobileMedia => ({
    longAndroidVideos: new Set(),
    staticDesktopVideos: new Map(),
});

export async function validateMobileEvidence(input: {
    blockedReason?: BlockedReason;
    caseId: string;
    device: z.infer<typeof mobileDeviceSchema>;
    directory: string;
    evidence: CitedEvidence[];
    evidenceBinding: z.infer<typeof mobileEvidenceBindingSchema>;
    expectedStatus: z.infer<typeof mobileDeviceReceiptSchema>['status'];
    reportCommit: string | undefined;
}): Promise<ValidatedMobileMedia> {
    const evidencePaths = input.evidence.map(({ path }) => path);
    if (new Set(evidencePaths).size !== evidencePaths.length) {
        throw new Error(`Case ${input.caseId} repeats an evidence path`);
    }
    const deviceEvidence = mobileDeviceEvidencePath(input.caseId);
    if (!evidencePaths.includes(deviceEvidence))
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
    if (deviceReceipt.cleanup.fixtureIme === 'pending')
        throw new Error(`Case ${input.caseId} fixture input method cleanup is incomplete`);
    if (
        input.blockedReason === 'execution-failed-before-evidence' &&
        (deviceReceipt.artifacts.length > 0 ||
            input.evidence.some(
                ({ path, source }) =>
                    mobileMediaType(path) !== undefined ||
                    source === 'isolated-desktop-renderer' ||
                    path === `assets/${encodeURIComponent(input.caseId)}-desktop-capture.json` ||
                    path === mobileResultEvidencePath(input.caseId),
            ))
    ) {
        throw new Error(
            `Case ${input.caseId} execution-failed-before-evidence cannot include captured media or result`,
        );
    }
    const desktopCapture = await validateDesktopCapture({
        caseId: input.caseId,
        deviceId: input.device.deviceId,
        directory: input.directory,
        evidenceBinding: input.evidenceBinding,
        evidence: input.evidence,
        reportCommit: input.reportCommit,
    });
    await validateMobileArtifacts({
        artifacts: deviceReceipt.artifacts,
        caseId: input.caseId,
        directory: input.directory,
        evidence: input.evidence,
        platform: input.device.platform,
        desktopPaths: desktopCapture.desktopPaths,
    });
    const media = emptyValidatedMedia();
    const journeyVideo = `assets/${encodeURIComponent(input.caseId)}-android.mp4`;
    if (
        input.caseId === 'MOB-E2E-01' &&
        input.device.platform === 'android' &&
        deviceReceipt.artifacts.some(
            (artifact) =>
                artifact.path === journeyVideo &&
                artifact.source === 'android-framebuffer' &&
                artifact.type === 'video',
        )
    ) {
        media.longAndroidVideos.add(journeyVideo);
    }
    const resultEvidence = mobileResultEvidencePath(input.caseId);
    if (desktopCapture.staticVideo) {
        media.staticDesktopVideos.set(
            desktopCapture.staticVideo.path,
            desktopCapture.staticVideo.durationMs,
        );
    }
    if (!evidencePaths.includes(resultEvidence)) return media;
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
    return media;
}

/**
 * Binds a mobile case's final receipt to the frozen device and completed lifecycle.
 */
export async function validateMobileCaseEvidence(input: {
    blockedReason?: BlockedReason;
    caseId: string;
    device?: z.infer<typeof mobileDeviceSchema>;
    directory: string;
    evidence: CitedEvidence[];
    reportCommit: string | undefined;
    stateIsolation: StateIsolation;
    status: 'pass' | 'fail' | 'blocked';
    surface: 'cli' | 'desktop' | 'mobile';
}): Promise<ValidatedMobileMedia> {
    if (input.surface !== 'mobile') return emptyValidatedMedia();
    if (!input.device) throw new Error(`Case ${input.caseId} is missing its mobile device plan`);
    const hasDeviceReceipt = await hasMobileDeviceReceipt(input.directory, input.caseId);
    if (!hasDeviceReceipt && input.blockedReason) {
        throw new Error(
            `Case ${input.caseId} ${input.blockedReason} requires a mobile device receipt`,
        );
    }
    if (!hasDeviceReceipt && input.status === 'blocked') return emptyValidatedMedia();

    let evidenceBinding: z.infer<typeof mobileEvidenceBindingSchema>;
    if (input.stateIsolation.mode === 'readonly_checkpoint') {
        evidenceBinding = { checkpointId: input.stateIsolation.checkpointId };
    } else {
        const lifecyclePath = join(input.directory, lifecycleEvidencePath(input.caseId));
        const lifecycleText = await readFile(lifecyclePath, 'utf8');
        const lifecycle: unknown = JSON.parse(lifecycleText);
        const finalLaunchId = caseLifecycleReceiptSchema.parse(lifecycle).launches.at(-1)?.id;
        if (!finalLaunchId) throw new Error(`Case ${input.caseId} lifecycle has no launch`);
        evidenceBinding = { launchId: finalLaunchId };
    }
    return validateMobileEvidence({
        blockedReason: input.blockedReason,
        caseId: input.caseId,
        device: input.device,
        directory: input.directory,
        evidenceBinding,
        evidence: input.evidence,
        expectedStatus:
            input.blockedReason === 'plan-evidence-gap'
                ? 'passed'
                : input.blockedReason === 'execution-failed-before-evidence'
                  ? 'failed'
                  : ({ blocked: 'blocked', fail: 'failed', pass: 'passed' } as const)[input.status],
        reportCommit: input.reportCommit,
    });
}
