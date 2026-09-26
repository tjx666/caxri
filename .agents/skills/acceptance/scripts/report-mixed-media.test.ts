import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { citeEvidenceList, writeProposal } from './__tests__/evidence-fixture';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from './case-lifecycle';
import type { InitializeReportInput } from './report';
import { finalizeReport, initializeReport } from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-mixed-media-${process.pid}`,
);
const roots: string[] = [];
const commit = 'a'.repeat(40);
const requirement = '移动端操作后桌面选中项保持稳定。';
const caseId = 'android-new-session-desktop';
const deviceId = 'emulator-5554';
const mobilePath = 'assets/android-new-session.png';
const beforePath = `assets/${caseId}-desktop-before.png`;
const afterPath = `assets/${caseId}-desktop-after.png`;
const desktopReceiptPath = `assets/${caseId}-desktop-capture.json`;
const deviceReceiptPath = `assets/${caseId}-mobile-device.json`;
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function mixedReport() {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    roots.push(root);
    const directory = join(root, 'round-1');
    await initializeReport({
        commit,
        directory,
        entry: '在指定设备上观察创建后的桌面选中项。',
        plan: [
            {
                category: '移动端新建会话',
                expected: '手机创建会话后，桌面保留原先选中的会话。',
                id: caseId,
                method: '在指定安卓模拟器执行操作，并检查隔离桌面的前后状态。',
                mobileDevice: {
                    appId: 'com.caxri.mobile',
                    deviceId,
                    platform: 'android',
                },
                requiredEvidence: [
                    { source: 'android-framebuffer', type: 'screenshot' },
                    { source: 'isolated-desktop-renderer', type: 'screenshot' },
                ],
                stateIsolation: { mode: 'isolated' },
                surface: 'mobile',
                title: '新建会话后桌面选中项保持稳定',
                verifier: 'agent',
            },
        ],
        requirement,
        title: '验收移动端和桌面协同',
    });
    await writeProposal(directory, '本轮检查跨端新建会话后，桌面原有选中项是否保持稳定。');
    const launchId = await beginCaseLifecycle(directory, {
        caseId,
        profileIdentity: `profile-${caseId}`,
        stateIsolation: { mode: 'isolated' },
    });
    await markCaseLifecycleReady(directory, { caseId, launchId });
    await completeCaseLifecycle(directory, {
        caseId,
        cleanupCompleted: true,
        cleanupRequested: true,
        launchId,
    });
    const resultPath = join(directory, 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        cases: Array<Record<string, unknown>>;
        plan: InitializeReportInput['plan'];
    };
    const caseResult = {
        category: '移动端新建会话',
        evidence: citeEvidenceList([
            `assets/${caseId}-state-isolation.json`,
            deviceReceiptPath,
            desktopReceiptPath,
            mobilePath,
            beforePath,
            afterPath,
        ]).map((item) => ({
            ...item,
            source:
                item.path === mobilePath
                    ? 'android-framebuffer'
                    : item.path === beforePath || item.path === afterPath
                      ? 'isolated-desktop-renderer'
                      : undefined,
        })),
        id: caseId,
        name: '新建会话后桌面选中项保持稳定',
        observation: '设备创建新会话后，隔离桌面的原选中项在前后截图中保持一致。',
        status: 'pass',
        surface: 'mobile',
    };
    result.cases[0] = caseResult;
    const deviceReceipt = {
        appId: 'com.caxri.mobile',
        artifacts: [
            {
                path: mobilePath,
                sha256: hash(PNG),
                source: 'android-framebuffer',
                type: 'screenshot',
            },
        ],
        build: { identity: 'apk-sha256', mode: 'release' },
        caseId,
        cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
        device: { id: deviceId, kind: 'emulator', platform: 'android' },
        launchId,
        outcome: 'new-session-created-desktop-selection-stable',
        schemaVersion: 1,
        sourceCommit: commit,
        status: 'passed',
    };
    const desktopReceipt = {
        appId: 'com.caxri.mobile',
        artifacts: [beforePath, afterPath].map((path) => ({
            path,
            sha256: hash(PNG),
            source: 'isolated-desktop-renderer',
            type: 'screenshot',
        })),
        caseId,
        cleanup: { desktopProfile: 'removed' },
        desktop: {
            pid: 1234,
            processStartedAt: 'Fri Sep 25 12:00:00 2026',
            profileIdentity: 'b'.repeat(64),
            targetId: 'target-1',
        },
        launchId,
        schemaVersion: 1,
        selectedSessionIdentity: 'c'.repeat(64),
        serial: deviceId,
        sourceCommit: commit,
    };
    await Promise.all([
        writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
        writeFile(join(directory, deviceReceiptPath), JSON.stringify(deviceReceipt)),
        writeFile(join(directory, desktopReceiptPath), JSON.stringify(desktopReceipt)),
        ...[mobilePath, beforePath, afterPath].map((path) => writeFile(join(directory, path), PNG)),
    ]);
    return { caseResult, desktopReceipt, deviceReceipt, directory, result, resultPath };
}

afterEach(async () => {
    const directories = [...roots];
    roots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance mixed Android and Desktop media', () => {
    it('keeps Android media device-bound when its scenario name mentions desktop', async () => {
        const fixture = await mixedReport();
        const { directory, deviceReceipt, result, resultPath } = fixture;
        const renamedPath = `assets/${caseId}-desktop-resized-under-lease-android.png`;
        result.plan[0].requiredEvidence = [{ source: 'android-framebuffer', type: 'screenshot' }];
        result.cases[0] = {
            ...fixture.caseResult,
            evidence: fixture.caseResult.evidence
                .filter(({ path }) => ![beforePath, afterPath, desktopReceiptPath].includes(path))
                .map((item) => ({
                    ...item,
                    path: item.path === mobilePath ? renamedPath : item.path,
                })),
        };
        deviceReceipt.artifacts[0].path = renamedPath;
        await Promise.all([
            rm(join(directory, desktopReceiptPath)),
            writeFile(join(directory, renamedPath), PNG),
            writeFile(join(directory, deviceReceiptPath), JSON.stringify(deviceReceipt)),
            writeFile(resultPath, JSON.stringify(result)),
        ]);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { passed: 1, verdict: 'pass' },
        });
        deviceReceipt.artifacts[0].sha256 = '0'.repeat(64);
        await writeFile(join(directory, deviceReceiptPath), JSON.stringify(deviceReceipt));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile media evidence is not device-bound',
        );
    });

    it('partitions receipt sources and binds every cited image to the same case and launch', async () => {
        const fixture = await mixedReport();
        const { directory, desktopReceipt, result, resultPath } = fixture;
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { passed: 1, verdict: 'pass' },
        });

        result.cases[0] = {
            ...fixture.caseResult,
            evidence: fixture.caseResult.evidence.filter(({ path }) => path !== mobilePath),
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'screenshot:android-framebuffer',
        );
        result.cases[0] = fixture.caseResult;
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

        result.cases[0] = {
            ...fixture.caseResult,
            blockedReason: 'plan-evidence-gap',
            observation: '设备创建新会话成功，但创建中进度画面缺失，桌面选中项前后保持稳定。',
            status: 'blocked',
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { blocked: 1, verdict: 'partial' },
        });

        for (const mutation of [
            { launchId: 'other-launch' },
            { sourceCommit: 'd'.repeat(40) },
            { serial: 'emulator-5556' },
            { cleanup: { desktopProfile: 'preserved' } },
            { desktop: { ...desktopReceipt.desktop, targetId: '' } },
        ]) {
            // Each mutation must be finalized before the next one replaces the same receipt.
            // eslint-disable-next-line no-await-in-loop
            await writeFile(
                join(directory, desktopReceiptPath),
                JSON.stringify({ ...desktopReceipt, ...mutation }),
            );
            // eslint-disable-next-line no-await-in-loop
            await expect(finalizeReport({ directory, requirement })).rejects.toThrow();
        }
        await writeFile(join(directory, desktopReceiptPath), JSON.stringify(desktopReceipt));
        await writeFile(join(directory, beforePath), Buffer.from('tampered'));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow();
    });
});
