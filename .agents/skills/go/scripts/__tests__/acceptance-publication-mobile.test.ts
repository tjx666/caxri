import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishAcceptanceRound } from '../acceptance-publication';
import { createInitialState } from '../state-model';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-publication-mobile-${process.pid}`,
);
const LOCAL_RECEIPT = {
    appId: 'com.caxri.mobile',
    artifacts: [],
    build: { identity: 'apk-sha256', mode: 'release' },
    caseId: 'MOB-ACC-03',
    cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
    device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
    launchId: 'launch-1',
    outcome: 'publication-readback-verified',
    schemaVersion: 1,
    sourceCommit: 'head-1',
    status: 'passed',
};

function publicationState(runId: string) {
    const state = createInitialState({ objective: 'Publish mobile Acceptance', runId });
    state.phase = 'acceptance';
    state.status = 'active';
    state.pullRequest.headSha = 'head-1';
    return state;
}

function runListJson() {
    return JSON.stringify([
        {
            acceptanceId: 'acc-1',
            context: { commit: 'head-1', testedAt: '2026-08-12T00:00:00.000Z' },
            id: 'run-1',
            plan: [{ id: 'MOB-ACC-03' }],
            roundIndex: 1,
            source: 'agent-testing',
        },
    ]);
}

function viewJson(
    surface: 'desktop' | 'mobile',
    receipt: string | { fileId: string; fileUrl: string },
) {
    const evidence =
        typeof receipt === 'string'
            ? { content: receipt, fileId: null, fileUrl: null, type: 'text' }
            : { content: null, ...receipt, type: 'text' };
    return JSON.stringify({
        acceptance: { id: 'acc-1' },
        checks: [
            {
                evidence: [evidence],
                id: 'MOB-ACC-03',
                planItem: { verifierConfig: { surface } },
                resultRound: 1,
                surface,
            },
        ],
        rounds: [
            {
                report: { verdict: 'passed' },
                run: {
                    acceptanceId: 'acc-1',
                    context: { commit: 'head-1' },
                    id: 'run-1',
                    roundIndex: 1,
                },
            },
        ],
    });
}

async function writeMobileRound(receipt: unknown = LOCAL_RECEIPT): Promise<string> {
    const directory = join(TEST_ROOT, 'round-1');
    await mkdir(join(directory, 'assets'), { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, 'result.json'),
            `${JSON.stringify(
                {
                    cases: [
                        {
                            evidence: ['assets/MOB-ACC-03-mobile-device.json'],
                            id: 'MOB-ACC-03',
                            surface: 'mobile',
                        },
                    ],
                    commit: 'head-1',
                    createdAt: '2026-08-12T00:00:00.000Z',
                    plan: [
                        {
                            id: 'MOB-ACC-03',
                            mobileDevice: {
                                appId: 'com.caxri.mobile',
                                deviceId: 'emulator-5554',
                                platform: 'android',
                            },
                            requiredEvidence: ['text'],
                            surface: 'mobile',
                        },
                    ],
                    requirement: '移动验收发布必须保留产品表面和设备身份。',
                    summary: { verdict: 'pass' },
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, 'assets/MOB-ACC-03-mobile-device.json'), JSON.stringify(receipt)),
    ]);
    return directory;
}

describe('Go mobile Acceptance publication', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT, { force: true, recursive: true });
    });

    afterAll(async () => {
        await rm(TEST_ROOT, { force: true, recursive: true });
    });

    it('rejects readback that changes the mobile surface or target device', async () => {
        const directory = await writeMobileRound();
        const wrongDeviceReceipt = JSON.stringify({
            ...LOCAL_RECEIPT,
            device: { ...LOCAL_RECEIPT.device, id: 'emulator-5556' },
        });
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(viewJson('desktop', wrongDeviceReceipt));
        await expect(
            publishAcceptanceRound(
                publicationState('mobile-readback'),
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow('surface');

        const deviceRunner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(
                viewJson(
                    'mobile',
                    JSON.stringify({
                        ...LOCAL_RECEIPT,
                        cleanup: { ...LOCAL_RECEIPT.cleanup, appData: 'preserved' },
                    }),
                ),
            );
        await expect(
            publishAcceptanceRound(
                publicationState('mobile-device-readback'),
                { headSha: 'head-1', reportDirectory: directory },
                deviceRunner,
            ),
        ).rejects.toThrow('mobileDevice');

        const matchingRunner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(viewJson('mobile', JSON.stringify(LOCAL_RECEIPT)));
        await expect(
            publishAcceptanceRound(
                publicationState('mobile-matching-readback'),
                { headSha: 'head-1', reportDirectory: directory },
                matchingRunner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-1', roundIndex: 1 });
    });

    it('verifies a large device receipt through the uploaded file hash and size', async () => {
        const largeReceipt = {
            ...LOCAL_RECEIPT,
            artifacts: Array.from({ length: 50 }, (_, index) => ({
                path: `assets/MOB-ACC-03-${index}.png`,
                sha256: String(index).padStart(64, '0'),
                source: 'android-framebuffer',
                type: 'screenshot',
            })),
        };
        const receiptText = JSON.stringify(largeReceipt);
        expect(receiptText.length).toBeGreaterThanOrEqual(5_000);
        const directory = await writeMobileRound(largeReceipt);
        const fileId = 'file-mobile-receipt';
        const remoteEvidence = viewJson('mobile', {
            fileId,
            fileUrl: 'https://files.example.test/mobile-device.json',
        });
        const mismatchedRunner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(remoteEvidence)
            .mockResolvedValueOnce(
                JSON.stringify({
                    hash: '0'.repeat(64),
                    id: fileId,
                    size: Buffer.byteLength(receiptText),
                }),
            );
        await expect(
            publishAcceptanceRound(
                publicationState('mobile-large-receipt-mismatch'),
                { headSha: 'head-1', reportDirectory: directory },
                mismatchedRunner,
            ),
        ).rejects.toThrow('mobileDevice');

        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(remoteEvidence)
            .mockResolvedValueOnce(
                JSON.stringify({
                    hash: createHash('sha256').update(receiptText).digest('hex'),
                    id: fileId,
                    size: Buffer.byteLength(receiptText),
                }),
            );

        await expect(
            publishAcceptanceRound(
                publicationState('mobile-large-receipt'),
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-1', roundIndex: 1 });
        expect(runner).toHaveBeenLastCalledWith('lobehub', ['file', 'view', fileId, '--json']);
    });
});
