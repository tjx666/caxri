import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { citeEvidenceList, writeProposal } from './__tests__/evidence-fixture';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from './case-lifecycle';
import { finalizeReport, initializeReport } from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_ROOT = join(PROJECT_ROOT, '.records', '__test__');
const roots: string[] = [];
const caseId = 'MOB-CROSS-01';
const reportCommit = 'a'.repeat(40);
const requirement = '移动端新建会话后，桌面保留原先选中的会话。';
const deviceEvidence = `assets/${caseId}-mobile-device.json`;
const diagnosticEvidence = `assets/${caseId}-execution-gap.txt`;
const orphanImage = `assets/${caseId}-selection-android.png`;
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

afterEach(async () => {
    const directories = [...roots];
    roots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('Acceptance execution failure before required media', () => {
    it('publishes a blocked observation without rewriting the failed device receipt', async () => {
        await mkdir(TEST_ROOT, { recursive: true });
        const root = await mkdtemp(join(TEST_ROOT, 'mobile-failed-execution-'));
        roots.push(root);
        const directory = join(root, 'round-1');
        await initializeReport({
            commit: reportCommit,
            directory,
            entry: '在指定安卓模拟器检查跨设备新建会话。',
            plan: [
                {
                    category: '跨设备新建会话',
                    expected: '手机创建会话后进入详情，桌面仍选中原先会话。',
                    id: caseId,
                    method: '在同一次隔离执行中观察手机过程与桌面前后状态。',
                    mobileDevice: {
                        appId: 'com.caxri.mobile',
                        deviceId: 'emulator-5554',
                        platform: 'android',
                    },
                    requiredEvidence: [
                        { source: 'android-framebuffer', type: 'video' },
                        { source: 'android-framebuffer', type: 'screenshot' },
                        { source: 'isolated-desktop-renderer', type: 'screenshot' },
                        'text',
                    ],
                    stateIsolation: { mode: 'isolated' },
                    surface: 'mobile',
                    title: '手机新建后桌面选中项不变',
                    verifier: 'agent',
                },
            ],
            requirement,
            title: '验收跨设备新建会话',
        });
        await writeProposal(directory, '本轮执行跨设备新建会话，请重点核对设备失败与证据边界。');
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
        const lifecycleEvidence = `assets/${caseId}-state-isolation.json`;
        const resultPath = join(directory, 'result.json');
        const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
            cases: Array<Record<string, unknown>>;
        };
        const blockedCase = {
            blockedReason: 'execution-failed-before-evidence',
            category: '跨设备新建会话',
            evidence: citeEvidenceList([lifecycleEvidence, deviceEvidence, diagnosticEvidence]),
            id: caseId,
            name: '手机新建后桌面选中项不变',
            observation:
                '设备执行在等待会话详情结果时超时，计划中的结果媒体未完成，无法判断产品是否满足跨设备要求。',
            status: 'blocked',
            surface: 'mobile',
        };
        result.cases[0] = blockedCase;
        const receipt = {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'apk-sha256', mode: 'release' },
            caseId,
            cleanup: { appData: 'cleared', desktopProfile: 'managed-by-isolated-e2e' },
            device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
            launchId,
            outcome: 'acceptance-case-did-not-pass',
            schemaVersion: 1,
            sourceCommit: reportCommit,
            status: 'failed',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(receipt)),
            writeFile(
                join(directory, diagnosticEvidence),
                'Observed runner timeout while waiting for the planned Conversation result; no result media was bound.\n',
            ),
            writeFile(join(directory, orphanImage), PNG),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { blocked: 1, passed: 0, verdict: 'partial' },
        });

        result.cases[0] = {
            ...blockedCase,
            evidence: [
                ...blockedCase.evidence,
                {
                    description: '用于核对执行中断前已绑定的手机截图。',
                    path: orphanImage,
                    source: 'android-framebuffer',
                },
            ],
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({
                ...receipt,
                artifacts: [
                    {
                        path: orphanImage,
                        sha256: createHash('sha256').update(PNG).digest('hex'),
                        source: 'android-framebuffer',
                        type: 'screenshot',
                    },
                ],
            }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'execution-failed-before-evidence cannot include captured media or result',
        );
        await writeFile(join(directory, deviceEvidence), JSON.stringify(receipt));

        const desktopImage = `assets/${caseId}-desktop-before.png`;
        await writeFile(join(directory, desktopImage), PNG);
        result.cases[0] = {
            ...blockedCase,
            evidence: [
                ...blockedCase.evidence,
                {
                    description: '用于核对执行中断前的桌面画面。',
                    path: desktopImage,
                    source: 'isolated-desktop-renderer',
                },
            ],
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'execution-failed-before-evidence cannot include captured media or result',
        );

        const mobileResultEvidence = `assets/${caseId}-result.json`;
        await writeFile(join(directory, mobileResultEvidence), '{}');
        result.cases[0] = {
            ...blockedCase,
            evidence: citeEvidenceList([
                lifecycleEvidence,
                deviceEvidence,
                diagnosticEvidence,
                mobileResultEvidence,
            ]),
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'execution-failed-before-evidence cannot include captured media or result',
        );

        result.cases[0] = { ...blockedCase, blockedReason: undefined };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile device receipt does not match the frozen plan',
        );

        result.cases[0] = blockedCase;
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        for (const mutation of [
            { status: 'passed' },
            { sourceCommit: 'b'.repeat(40) },
            { launchId: 'stale-launch' },
            { device: { ...receipt.device, id: 'emulator-5556' } },
        ]) {
            // Sequential rewrites preserve one independently checked tamper per finalization.
            // eslint-disable-next-line no-await-in-loop
            await writeFile(
                join(directory, deviceEvidence),
                JSON.stringify({ ...receipt, ...mutation }),
            );
            // eslint-disable-next-line no-await-in-loop
            await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
                'mobile device receipt does not match the frozen plan',
            );
        }
        await writeFile(join(directory, deviceEvidence), JSON.stringify(receipt));
        result.cases[0] = {
            ...blockedCase,
            evidence: citeEvidenceList([lifecycleEvidence, deviceEvidence]),
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'requires a sanitized diagnostic text file',
        );

        result.cases[0] = {
            ...blockedCase,
            evidence: citeEvidenceList([
                lifecycleEvidence,
                deviceEvidence,
                diagnosticEvidence,
                orphanImage,
            ]),
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'execution-failed-before-evidence cannot include captured media or result',
        );

        result.cases[0] = blockedCase;
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await writeFile(join(directory, diagnosticEvidence), 'Timeout.\n');
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'failure diagnostic must be a bounded, concrete text summary',
        );
        await writeFile(
            join(directory, diagnosticEvidence),
            'Observed runner timeout while waiting for the planned Conversation result; no result media was bound.\n',
        );
        const lifecyclePath = join(directory, lifecycleEvidence);
        const lifecycle = JSON.parse(await readFile(lifecyclePath, 'utf8')) as {
            launches: Array<Record<string, unknown>>;
        };
        const cleanLifecycle = JSON.stringify(lifecycle);
        lifecycle.launches[0].cleanupCompleted = false;
        await writeFile(lifecyclePath, JSON.stringify(lifecycle));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'isolated profile was not cleaned up',
        );
        await writeFile(lifecyclePath, cleanLifecycle);
        await rm(join(directory, deviceEvidence));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'Evidence file does not exist',
        );
    });
});
