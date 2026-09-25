import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { execFileAsync } from '@caxri/system';

import { assertDecodablePng } from '../../.agents/skills/acceptance/scripts/png-integrity';
import { errorCode } from '../../.agents/skills/acceptance/scripts/report-paths';
import type { RunningCaxri } from './helpers';
import { pageRequest, sessionCard } from './helpers';

type CapturePhase = 'before' | 'after';

interface DesktopIdentity {
    pid: number;
    processStartedAt: string;
    profileIdentity: string;
    targetId: string;
}

export interface DesktopArtifact {
    path: string;
    sha256: string;
    source: 'isolated-desktop-renderer';
    type: 'screenshot' | 'video';
}

interface DesktopRecording {
    actualSampleCount: number;
    durationMs: number;
    endedAt: string;
    maxSampleGapMs: number;
    sampleCount: number;
    sampleRate: 2;
    startedAt: string;
}

export interface MobileDesktopCaptureInput {
    assetsDirectory: string;
    caseId: string;
    launchId: string;
    profileDirectory: string;
    running: RunningCaxri;
    serial: string;
    sourceCommit: string;
}

export interface MobileDesktopCapture {
    capture(phase: CapturePhase): Promise<DesktopArtifact>;
    startRecording(): Promise<void>;
    stopRecording(): Promise<DesktopArtifact>;
    finalizeAfterCleanup(input: { cleanupConfirmed: boolean }): Promise<{
        artifacts: DesktopArtifact[];
        receiptPath: string;
    }>;
}

const APP_ID = 'com.caxri.mobile';
const SAMPLE_INTERVAL_MS = 500;
const MAX_SAMPLE_GAP_MS = 1_500;
const MAX_RECORDING_MS = 180_000;
const MIN_RECORDING_MS = 3_000;
const SAFE_ROW_STYLE = `
    .session-card {
        color: transparent !important;
        text-shadow: none !important;
    }
    .session-card *, .session-card::before, .session-card::after {
        visibility: hidden !important;
    }
`;

const sha256 = (content: string | Uint8Array): string =>
    createHash('sha256').update(content).digest('hex');

interface FrameSample {
    atMs: number;
    png: Buffer;
}

interface ActiveRecording {
    startedAtMs: number;
    samples: FrameSample[];
    stopRequested: boolean;
    task: Promise<void>;
    failure?: unknown;
}

function maximumSampleGap(durationMs: number, samples: FrameSample[]): number {
    const boundaries = [0, ...samples.map(({ atMs }) => atMs), durationMs];
    return Math.max(...boundaries.slice(1).map((atMs, index) => atMs - boundaries[index]));
}

async function encodeDesktopVideo(input: {
    assetsDirectory: string;
    caseId: string;
    durationMs: number;
    samples: FrameSample[];
}): Promise<{ artifact: DesktopArtifact; sampleCount: number }> {
    const sampleCount = Math.ceil(input.durationMs / SAMPLE_INTERVAL_MS);
    if (sampleCount > Math.ceil(MAX_RECORDING_MS / SAMPLE_INTERVAL_MS)) {
        throw new Error('Desktop recording exceeded its bounded capture window');
    }
    const framesDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-frames-'));
    const fileName = `${encodeURIComponent(input.caseId)}-desktop.mp4`;
    const videoPath = join(input.assetsDirectory, fileName);
    try {
        let sampleIndex = 0;
        const frameWrites = Array.from({ length: sampleCount }, (_, index) => {
            const atMs = index * SAMPLE_INTERVAL_MS;
            while (
                sampleIndex + 1 < input.samples.length &&
                input.samples[sampleIndex + 1].atMs <= atMs
            ) {
                sampleIndex += 1;
            }
            const frameName = `frame-${String(index).padStart(6, '0')}.png`;
            return writeFile(join(framesDirectory, frameName), input.samples[sampleIndex].png);
        });
        await Promise.all(frameWrites);
        await mkdir(input.assetsDirectory, { recursive: true });
        await execFileAsync(
            'ffmpeg',
            [
                '-v',
                'error',
                '-framerate',
                '2',
                '-i',
                join(framesDirectory, 'frame-%06d.png'),
                '-vf',
                'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-r',
                '12',
                '-movflags',
                '+faststart',
                '-n',
                videoPath,
            ],
            { timeout: 120_000 },
        );
        const video = await readFile(videoPath);
        return {
            artifact: {
                path: `assets/${fileName}`,
                sha256: sha256(video),
                source: 'isolated-desktop-renderer',
                type: 'video',
            },
            sampleCount,
        };
    } catch (error) {
        await rm(videoPath, { force: true });
        throw error;
    } finally {
        await rm(framesDirectory, { force: true, recursive: true });
    }
}

async function processStartIdentity(pid: number): Promise<string> {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 5_000,
    });
    const value = stdout.trim();
    if (!value) throw new Error('Owned Desktop Main process is no longer running');
    return value;
}

/**
 * A Desktop image must belong to the same isolated process, profile, and CDP page throughout the mobile action. Only a
 * digest of the profile path enters the receipt; the path itself remains in the temporary fixture.
 */
export async function createMobileDesktopCapture(
    input: MobileDesktopCaptureInput,
): Promise<MobileDesktopCapture> {
    if (!/^[0-9a-f]{40}$/iu.test(input.sourceCommit))
        throw new Error('Desktop capture requires the exact source commit');
    if (!input.caseId || !input.launchId || !input.serial)
        throw new Error('Desktop capture identity is incomplete');
    const pid = input.running.app.process().pid;
    if (!pid) throw new Error('Owned Desktop Main process is unavailable');
    const cdp = await input.running.page.context().newCDPSession(input.running.page);
    const target = await cdp.send('Target.getTargetInfo');
    const targetId = target.targetInfo.targetId;
    if (!targetId || target.targetInfo.type !== 'page')
        throw new Error('Owned Desktop Renderer CDP target is unavailable');
    const identity: DesktopIdentity = {
        pid,
        processStartedAt: await processStartIdentity(pid),
        profileIdentity: sha256(input.profileDirectory),
        targetId,
    };
    const sessionIds = new Map<CapturePhase, string>();
    const artifacts = new Map<CapturePhase, DesktopArtifact>();
    let activeRecording: ActiveRecording | undefined;
    let videoArtifact: DesktopArtifact | undefined;
    let recording: DesktopRecording | undefined;

    const assertOwnedIdentity = async (): Promise<void> => {
        const currentPid = input.running.app.process().pid;
        const currentTarget = await cdp.send('Target.getTargetInfo');
        const profile = await input.running.app.evaluate(({ app }) => app.getPath('userData'));
        if (
            currentPid !== identity.pid ||
            (await processStartIdentity(identity.pid)) !== identity.processStartedAt ||
            currentTarget.targetInfo.targetId !== identity.targetId ||
            currentTarget.targetInfo.type !== 'page' ||
            sha256(profile) !== identity.profileIdentity ||
            profile !== input.profileDirectory ||
            input.running.page.isClosed()
        ) {
            throw new Error('Desktop capture left the owned process, profile, or Renderer target');
        }
    };

    const captureSafeRow = async (
        expectedSessionId?: string,
    ): Promise<{
        png: Buffer;
        sessionId: string;
    }> => {
        await assertOwnedIdentity();
        if (
            (await input.running.page
                .locator('[role="dialog"]:visible, [role="menu"]:visible')
                .count()) > 0
        ) {
            throw new Error('Desktop overlay must be dismissed before a safe capture');
        }
        const state = await pageRequest<{ selectedSessionId?: string }>(
            input.running.page,
            'app.bootstrap',
        );
        const sessionId = state.selectedSessionId;
        if (!sessionId) throw new Error('Desktop selected Session is unavailable for capture');
        if (expectedSessionId && sessionId !== expectedSessionId) {
            throw new Error('Desktop selected Session changed during the mobile action');
        }
        const row = sessionCard(input.running.page, sessionId);
        if ((await row.count()) !== 1 || (await row.getAttribute('aria-selected')) !== 'true') {
            throw new Error('Desktop selected Session row is not uniquely visible');
        }
        const png = await row.screenshot({ animations: 'disabled', style: SAFE_ROW_STYLE });
        await assertOwnedIdentity();
        await assertDecodablePng(png);
        return { png, sessionId };
    };

    return {
        async capture(phase) {
            if (artifacts.has(phase)) throw new Error(`Desktop ${phase} image already exists`);
            if (phase === 'after' && !artifacts.has('before'))
                throw new Error('Desktop before image is required first');
            const { png, sessionId } = await captureSafeRow(
                phase === 'after' ? sessionIds.get('before') : undefined,
            );
            await mkdir(input.assetsDirectory, { recursive: true });
            const fileName = `${encodeURIComponent(input.caseId)}-desktop-${phase}.png`;
            const path = `assets/${fileName}`;
            await writeFile(join(input.assetsDirectory, fileName), png, { flag: 'wx' });
            const artifact: DesktopArtifact = {
                path,
                sha256: sha256(png),
                source: 'isolated-desktop-renderer',
                type: 'screenshot',
            };
            sessionIds.set(phase, sessionId);
            artifacts.set(phase, artifact);
            return artifact;
        },
        async startRecording() {
            if (activeRecording || recording || videoArtifact)
                throw new Error('Desktop recording already started');
            const expectedSessionId = sessionIds.get('before');
            if (!expectedSessionId || artifacts.has('after')) {
                throw new Error('Desktop before image must precede recording');
            }
            const startedAtMs = Date.now();
            const first = await captureSafeRow(expectedSessionId);
            activeRecording = {
                startedAtMs,
                samples: [{ atMs: Date.now() - startedAtMs, png: first.png }],
                stopRequested: false,
                task: Promise.resolve(),
            };
            const current = activeRecording;
            const shouldStop = (): boolean => current.stopRequested;
            current.task = (async () => {
                // A capture must finish before the next interval so frames cannot reorder or race over one CDP page.
                /* eslint-disable no-await-in-loop */
                while (!shouldStop()) {
                    await sleep(SAMPLE_INTERVAL_MS);
                    if (shouldStop()) break;
                    try {
                        const frame = await captureSafeRow(expectedSessionId);
                        current.samples.push({
                            atMs: Date.now() - current.startedAtMs,
                            png: frame.png,
                        });
                    } catch (error) {
                        current.failure = error;
                        break;
                    }
                }
                /* eslint-enable no-await-in-loop */
            })();
        },
        async stopRecording() {
            if (videoArtifact) return videoArtifact;
            const current = activeRecording;
            if (!current) throw new Error('Desktop recording was not started');
            current.stopRequested = true;
            await current.task;
            if (current.failure) {
                throw current.failure instanceof Error
                    ? current.failure
                    : new Error('Desktop recording frame capture failed');
            }
            const endedAtMs = Date.now();
            const durationMs = endedAtMs - current.startedAtMs;
            if (durationMs < MIN_RECORDING_MS || durationMs > MAX_RECORDING_MS) {
                throw new Error('Desktop recording duration is outside the Acceptance bound');
            }
            if (current.samples.length < 2)
                throw new Error('Desktop recording did not sample the live Renderer');
            const maxSampleGapMs = maximumSampleGap(durationMs, current.samples);
            if (maxSampleGapMs > MAX_SAMPLE_GAP_MS) {
                throw new Error('Desktop recording has an unsampled Renderer interval');
            }
            const encoded = await encodeDesktopVideo({
                assetsDirectory: input.assetsDirectory,
                caseId: input.caseId,
                durationMs,
                samples: current.samples,
            });
            videoArtifact = encoded.artifact;
            recording = {
                actualSampleCount: current.samples.length,
                durationMs,
                endedAt: new Date(endedAtMs).toISOString(),
                maxSampleGapMs,
                sampleCount: encoded.sampleCount,
                sampleRate: 2,
                startedAt: new Date(current.startedAtMs).toISOString(),
            };
            activeRecording = undefined;
            return videoArtifact;
        },
        async finalizeAfterCleanup({ cleanupConfirmed }) {
            if (!cleanupConfirmed) throw new Error('Desktop fixture cleanup is unconfirmed');
            if (activeRecording) throw new Error('Desktop recording must stop before cleanup');
            try {
                await lstat(input.profileDirectory);
                throw new Error('Desktop fixture profile still exists after cleanup');
            } catch (error: unknown) {
                if (errorCode(error) !== 'ENOENT') throw error;
            }
            const before = artifacts.get('before');
            const after = artifacts.get('after');
            if (!before || !after || sessionIds.get('before') !== sessionIds.get('after')) {
                throw new Error('Desktop before and after captures are incomplete');
            }
            const allArtifacts = videoArtifact ? [before, after, videoArtifact] : [before, after];
            const persisted = await Promise.all(
                allArtifacts.map(async (artifact) => {
                    const fileName = artifact.path.slice('assets/'.length);
                    const bytes = await readFile(join(input.assetsDirectory, fileName));
                    return sha256(bytes) === artifact.sha256;
                }),
            );
            if (persisted.includes(false)) {
                throw new Error('Desktop capture changed before receipt finalization');
            }
            const receiptPath = join(
                input.assetsDirectory,
                `${encodeURIComponent(input.caseId)}-desktop-capture.json`,
            );
            const receipt = {
                appId: APP_ID,
                artifacts: allArtifacts,
                caseId: input.caseId,
                cleanup: { desktopProfile: 'removed' },
                desktop: identity,
                launchId: input.launchId,
                ...(recording && { recording }),
                schemaVersion: 1,
                selectedSessionIdentity: sha256(sessionIds.get('before') ?? ''),
                serial: input.serial,
                sourceCommit: input.sourceCommit,
            };
            await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
            return { artifacts: allArtifacts, receiptPath };
        },
    };
}
