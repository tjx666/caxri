import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import type { MediaCommandRunner } from './media-integrity';
import { validateReportMediaEvidence, validateVideoEvidence } from './media-integrity';

const roots: string[] = [];
const recordsRoot = join(process.cwd(), '.records', '__test__');

async function temporaryRoot(): Promise<string> {
    await mkdir(recordsRoot, { recursive: true });
    const root = await mkdtemp(join(recordsRoot, 'acceptance-media-'));
    roots.push(root);
    return root;
}

function runnerFor({
    duration = 10,
    frameCount = 40,
    hashes = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd'],
}: {
    duration?: number;
    frameCount?: number;
    hashes?: string[];
} = {}): MediaCommandRunner {
    return (command) => {
        if (command === 'ffprobe') {
            return Promise.resolve(
                JSON.stringify({
                    format: { duration: String(duration) },
                    streams: [{ avg_frame_rate: '4/1', nb_frames: String(frameCount) }],
                }),
            );
        }
        return Promise.resolve(
            hashes.map((hash, index) => `0, ${index}, ${index}, 1, 576, ${hash}`).join('\n'),
        );
    };
}

afterEach(async () => {
    const directories = [...roots];
    roots.length = 0;
    await Promise.all(directories.map((root) => rm(root, { recursive: true })));
});

describe('Acceptance media integrity', () => {
    it('rejects the four-frame one-second baseline clip that was mistaken for video evidence', async () => {
        await expect(
            validateVideoEvidence('/tmp/baseline.mp4', runnerFor({ duration: 1, frameCount: 4 })),
        ).rejects.toThrow('at least 3 seconds');
    });

    it('rejects a long clip whose sampled frames do not show a visible state change', async () => {
        const hashes = Array.from({ length: 20 }, () => 'same');
        await expect(
            validateVideoEvidence('/tmp/static.mp4', runnerFor({ hashes })),
        ).rejects.toThrow('at least 3 distinct sampled frames');
    });

    it('allows a receipt-bound static Desktop recording while checking its declared duration', async () => {
        const root = await temporaryRoot();
        const directory = join(root, 'round-1');
        const evidence = 'assets/MOB-E2E-01-desktop.mp4';
        await mkdir(join(directory, 'assets'), { recursive: true });
        await writeFile(join(directory, evidence), 'synthetic-video-bytes');
        const runner = runnerFor({ hashes: Array.from({ length: 20 }, () => 'same') });
        const report = {
            cases: [{ evidence: [evidence], id: 'MOB-E2E-01', status: 'pass' as const }],
            directory,
            plans: [{ id: 'MOB-E2E-01', requiredEvidence: ['video'] }],
            runner,
        };
        await expect(validateReportMediaEvidence(report)).rejects.toThrow(
            'at least 3 distinct sampled frames',
        );
        await expect(
            validateReportMediaEvidence({
                ...report,
                staticDesktopVideos: new Map([[evidence, 10_000]]),
            }),
        ).resolves.toBeUndefined();
        await expect(
            validateReportMediaEvidence({
                ...report,
                staticDesktopVideos: new Map([[evidence, 9_000]]),
            }),
        ).rejects.toThrow('duration does not match its receipt');
        await expect(
            validateVideoEvidence('/tmp/desktop.mp4', runnerFor({ duration: 181 }), {
                allowStaticDesktop: true,
            }),
        ).rejects.toThrow('at most 180 seconds');
    });

    it('rejects an excessively long clip before sampling it', async () => {
        await expect(
            validateVideoEvidence('/tmp/unbounded.mp4', runnerFor({ duration: 121 })),
        ).rejects.toThrow('at most 120 seconds');
    });

    it('allows a verified long Android journey without waiving visible frame changes', async () => {
        const root = await temporaryRoot();
        const directory = join(root, 'round-1');
        const evidence = 'assets/MOB-E2E-01-android.mp4';
        await mkdir(join(directory, 'assets'), { recursive: true });
        await writeFile(join(directory, evidence), 'synthetic-android-video-bytes');
        const runner = runnerFor({ duration: 170, frameCount: 680 });
        const report = {
            cases: [{ evidence: [evidence], id: 'MOB-E2E-01', status: 'pass' as const }],
            directory,
            plans: [{ id: 'MOB-E2E-01', requiredEvidence: ['video'] }],
            runner,
        };
        await expect(validateReportMediaEvidence(report)).rejects.toThrow('at most 120 seconds');
        await expect(
            validateReportMediaEvidence({
                ...report,
                longAndroidVideos: new Set([evidence]),
            }),
        ).resolves.toBeUndefined();
        const staticHashes = Array.from({ length: 20 }, () => 'same');
        await expect(
            validateVideoEvidence(
                '/tmp/static-android.mp4',
                runnerFor({
                    duration: 170,
                    frameCount: 680,
                    hashes: staticHashes,
                }),
                { allowLongAndroidJourney: true },
            ),
        ).rejects.toThrow('at least 3 distinct sampled frames');
        await expect(
            validateVideoEvidence('/tmp/too-long-android.mp4', runnerFor({ duration: 181 }), {
                allowLongAndroidJourney: true,
            }),
        ).rejects.toThrow('at most 180 seconds');
    });

    it('accepts a bounded clip with enough frames and visible variation', async () => {
        await expect(
            validateVideoEvidence('/tmp/interaction.mp4', runnerFor()),
        ).resolves.toMatchObject({
            distinctSampledFrames: 4,
            durationSeconds: 10,
            frameCount: 40,
            sampledFrameCount: 8,
        });
    });

    it('rejects media copied from a blocked prior round and relabeled as a pass', async () => {
        const root = await temporaryRoot();
        const firstRound = join(root, 'round-1');
        const secondRound = join(root, 'round-2');
        await Promise.all([
            mkdir(join(firstRound, 'assets'), { recursive: true }),
            mkdir(join(secondRound, 'assets'), { recursive: true }),
        ]);
        const evidence = 'assets/interaction.mp4';
        await Promise.all([
            writeFile(join(firstRound, evidence), 'same-media'),
            writeFile(join(secondRound, evidence), 'same-media'),
            writeFile(
                join(firstRound, 'result.json'),
                JSON.stringify({
                    cases: [{ evidence: [evidence], id: 'interaction', status: 'blocked' }],
                }),
            ),
        ]);

        await expect(
            validateReportMediaEvidence({
                cases: [{ evidence: [evidence], id: 'interaction', status: 'pass' }],
                directory: secondRound,
                plans: [{ id: 'interaction', requiredEvidence: ['video'] }],
                runner: runnerFor(),
            }),
        ).rejects.toThrow('reuses media from interaction in non-passing round-1');
    });

    it('rejects blocked prior-round media copied under a different passing case id', async () => {
        const root = await temporaryRoot();
        const firstRound = join(root, 'round-1');
        const secondRound = join(root, 'round-2');
        await Promise.all([
            mkdir(join(firstRound, 'assets'), { recursive: true }),
            mkdir(join(secondRound, 'assets'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(firstRound, 'assets/blocked.mp4'), 'same-media'),
            writeFile(join(secondRound, 'assets/renamed.mp4'), 'same-media'),
            writeFile(
                join(firstRound, 'result.json'),
                JSON.stringify({
                    cases: [
                        {
                            evidence: ['assets/blocked.mp4'],
                            id: 'blocked-case',
                            status: 'blocked',
                        },
                    ],
                }),
            ),
        ]);

        await expect(
            validateReportMediaEvidence({
                cases: [{ evidence: ['assets/renamed.mp4'], id: 'passing-case', status: 'pass' }],
                directory: secondRound,
                plans: [{ id: 'passing-case', requiredEvidence: ['video'] }],
                runner: runnerFor(),
            }),
        ).rejects.toThrow('reuses media from blocked-case in non-passing round-1');
    });

    it('rejects media reused from a non-passing case in the current round', async () => {
        const root = await temporaryRoot();
        const directory = join(root, 'round-1');
        await mkdir(join(directory, 'assets'), { recursive: true });
        await Promise.all([
            writeFile(join(directory, 'assets/blocked.mp4'), 'same-media'),
            writeFile(join(directory, 'assets/passing.mp4'), 'same-media'),
        ]);

        await expect(
            validateReportMediaEvidence({
                cases: [
                    { evidence: ['assets/passing.mp4'], id: 'passing-case', status: 'pass' },
                    { evidence: ['assets/blocked.mp4'], id: 'blocked-case', status: 'blocked' },
                ],
                directory,
                plans: [
                    { id: 'passing-case', requiredEvidence: ['video'] },
                    { id: 'blocked-case', requiredEvidence: ['video'] },
                ],
                runner: runnerFor(),
            }),
        ).rejects.toThrow('reuses media from non-passing case blocked-case in the current round');
    });

    it('rejects prior-round media paths that escape the assets directory', async () => {
        const root = await temporaryRoot();
        const firstRound = join(root, 'round-1');
        const secondRound = join(root, 'round-2');
        await Promise.all([
            mkdir(join(firstRound, 'assets'), { recursive: true }),
            mkdir(join(secondRound, 'assets'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(firstRound, 'outside.mp4'), 'outside-media'),
            writeFile(join(secondRound, 'assets/current.mp4'), 'current-media'),
            writeFile(
                join(firstRound, 'result.json'),
                JSON.stringify({
                    cases: [
                        {
                            evidence: ['assets/../outside.mp4'],
                            id: 'blocked-case',
                            status: 'blocked',
                        },
                    ],
                }),
            ),
        ]);

        await expect(
            validateReportMediaEvidence({
                cases: [{ evidence: ['assets/current.mp4'], id: 'current', status: 'pass' }],
                directory: secondRound,
                plans: [{ id: 'current', requiredEvidence: ['video'] }],
                runner: runnerFor(),
            }),
        ).rejects.toThrow('must stay under assets');
    });

    it('rejects identical video bytes attached to different passing cases', async () => {
        const root = await temporaryRoot();
        const directory = join(root, 'round-1');
        await mkdir(join(directory, 'assets'), { recursive: true });
        await Promise.all([
            writeFile(join(directory, 'assets/first.mp4'), 'duplicate-media'),
            writeFile(join(directory, 'assets/second.mp4'), 'duplicate-media'),
        ]);

        await expect(
            validateReportMediaEvidence({
                cases: [
                    { evidence: ['assets/first.mp4'], id: 'first', status: 'pass' },
                    { evidence: ['assets/second.mp4'], id: 'second', status: 'pass' },
                ],
                directory,
                plans: [
                    { id: 'first', requiredEvidence: ['video'] },
                    { id: 'second', requiredEvidence: ['video'] },
                ],
                runner: runnerFor(),
            }),
        ).rejects.toThrow('duplicates video evidence across cases first and second');
    });
});
