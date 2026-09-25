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
import { createTerminalFixturePreflightReceipt } from './fixture-preflight';
import type { InitializeReportInput } from './report';
import { finalizeReport, initializeReport } from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-mobile-report-${process.pid}`,
);
const acceptanceRoots: string[] = [];
const requirement = 'Caxri 移动端应安全连接并呈现配对的 Agent Sessions。';
const reportCommit = 'a'.repeat(40);
const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const desktopPlan = {
    category: '终端布局',
    expected: '终端视口周围不出现应用背景色条。',
    id: 'terminal-layout',
    method: '启动隔离的 Caxri 并检查稳定后的终端布局。',
    requiredEvidence: ['screenshot', 'dom_snapshot'],
    stateIsolation: { mode: 'isolated' },
    surface: 'desktop',
    title: '终端内容填满工作区',
    verifier: 'agent',
} satisfies InitializeReportInput['plan'][number];

interface ReportFixture {
    cases: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

const parseReport = (raw: string): ReportFixture => JSON.parse(raw) as ReportFixture;

async function reportDirectory(): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    acceptanceRoots.push(root);
    return join(root, 'round-1');
}

async function initialize(directory: string, plan: InitializeReportInput['plan']) {
    const path = await initializeReport({
        commit: reportCommit,
        directory,
        entry: '在指定移动设备上执行隔离验收。',
        plan,
        requirement,
        title: '验收 Caxri 移动端',
    });
    await writeProposal(directory, '本轮交付移动端配对与短回复路径，请重点看设备收据的绑定。');
    return path;
}

async function writeIsolatedLifecycle(
    directory: string,
    caseId: string,
    isReady = true,
): Promise<{ evidence: string; launchId: string }> {
    const launchId = await beginCaseLifecycle(directory, {
        caseId,
        profileIdentity: `profile-${caseId}`,
        stateIsolation: { mode: 'isolated' },
    });
    if (isReady) await markCaseLifecycleReady(directory, { caseId, launchId });
    await completeCaseLifecycle(directory, {
        caseId,
        cleanupCompleted: true,
        cleanupRequested: true,
        launchId,
    });
    return {
        evidence: `assets/${encodeURIComponent(caseId)}-state-isolation.json`,
        launchId,
    };
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance mobile report scaffold', () => {
    it('preserves desktop and mobile surfaces from the frozen plan', async () => {
        const directory = await reportDirectory();
        const mobilePlan = {
            category: '移动端配对',
            expected: 'Android 客户端能连接到等待中的 Agent Session 并发送一次短回复。',
            id: 'android-short-reply',
            method: '在一次性 Android 模拟器上运行发布构建并观察回复后的 Session 状态。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'emulator-5554',
                platform: 'android',
            },
            requiredEvidence: ['text'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: 'Android 短回复到达等待中的 Agent',
            verifier: 'program',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [desktopPlan, mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const desktopLifecycle = await writeIsolatedLifecycle(directory, desktopPlan.id);
        const mobileLifecycle = await writeIsolatedLifecycle(directory, mobilePlan.id);
        result.cases[0] = {
            category: desktopPlan.category,
            evidence: citeEvidenceList([
                'assets/terminal.png',
                'assets/terminal-dom.html',
                desktopLifecycle.evidence,
            ]),
            id: desktopPlan.id,
            name: desktopPlan.title,
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        result.cases[1] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList([
                'assets/android-short-reply-mobile-device.json',
                'assets/android-short-reply-result.json',
                mobileLifecycle.evidence,
            ]),
            id: mobilePlan.id,
            name: mobilePlan.title,
            observation: '发布构建完成配对，并将一次短回复送达等待中的 Agent Session。',
            status: 'pass',
            surface: 'mobile',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
            writeFile(join(directory, 'assets/terminal-dom.html'), '<main>terminal</main>'),
            writeFile(
                join(directory, 'assets/android-short-reply-mobile-device.json'),
                JSON.stringify({
                    appId: 'com.caxri.mobile',
                    artifacts: [],
                    build: { identity: 'apk-sha256', mode: 'release' },
                    caseId: mobilePlan.id,
                    cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
                    device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
                    outcome: 'one-bounded-reply-reached-the-waiting-agent',
                    launchId: mobileLifecycle.launchId,
                    schemaVersion: 1,
                    sourceCommit: reportCommit,
                    status: 'passed',
                }),
            ),
            writeFile(
                join(directory, 'assets/android-short-reply-result.json'),
                JSON.stringify({
                    channel: 'authenticated-encrypted-gateway',
                    delivery: {
                        count: 1,
                        destination: 'main-agent-terminal',
                        repeatDisabled: true,
                        stateAfterReply: 'running',
                    },
                    launchId: mobileLifecycle.launchId,
                    projectScope: 'allowed-present-denied-absent',
                    schemaVersion: 1,
                    sourceCommit: reportCommit,
                    status: 'passed',
                }),
            ),
        ]);

        const finalized = await finalizeReport({ directory, requirement });
        expect(finalized.surfaces).toEqual(['desktop', 'mobile']);
        expect(finalized.cases.map(({ surface }) => surface)).toEqual(['desktop', 'mobile']);
        expect(finalized.summary.conclusion).toBe('当前 PR 头提交满足全部计划中的验收项。');

        const resultReceiptPath = join(directory, 'assets/android-short-reply-result.json');
        const resultReceipt = JSON.parse(await readFile(resultReceiptPath, 'utf8')) as Record<
            string,
            unknown
        >;
        await writeFile(
            resultReceiptPath,
            JSON.stringify({ ...resultReceipt, launchId: 'stale-launch' }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile result receipt is stale',
        );
    });

    it('rejects a mobile case without its report-bound device receipt', async () => {
        const directory = await reportDirectory();
        const caseId = 'android-pairing-entry';
        const mobilePlan = {
            category: '移动端配对',
            expected: 'Android 客户端能显示可用的配对入口。',
            id: caseId,
            method: '在一次性 Android 模拟器上检查当前发布构建。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'emulator-5554',
                platform: 'android',
            },
            requiredEvidence: ['screenshot'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: 'Android 显示配对入口',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycle = await writeIsolatedLifecycle(directory, caseId);
        result.cases[0] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList(['assets/android-pairing.png', lifecycle.evidence]),
            id: caseId,
            name: mobilePlan.title,
            observation: 'Android 发布构建显示了配对入口。',
            status: 'pass',
            surface: 'mobile',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/android-pairing.png'), VALID_PNG),
        ]);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'must include its mobile device receipt',
        );

        const deviceEvidence = `assets/${caseId}-mobile-device.json`;
        result.cases[0] = {
            ...result.cases[0],
            evidence: citeEvidenceList([
                'assets/android-pairing.png',
                deviceEvidence,
                lifecycle.evidence,
            ]),
        };
        const receipt = {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'apk-sha256', mode: 'release' },
            caseId,
            cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
            device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
            launchId: lifecycle.launchId,
            outcome: 'pairing-entry-observed',
            schemaVersion: 1,
            sourceCommit: reportCommit,
            status: 'passed',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(receipt)),
        ]);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'must bind mobile media evidence',
        );

        await writeFile(
            join(directory, 'assets/android-pairing.png'),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
        );
        const malformedImage = await readFile(join(directory, 'assets/android-pairing.png'));
        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({
                ...receipt,
                artifacts: [
                    {
                        path: 'assets/android-pairing.png',
                        sha256: createHash('sha256').update(malformedImage).digest('hex'),
                        source: 'android-framebuffer',
                        type: 'screenshot',
                    },
                ],
            }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow('decodable PNG');

        await writeFile(join(directory, 'assets/android-pairing.png'), VALID_PNG);

        const image = await readFile(join(directory, 'assets/android-pairing.png'));
        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({
                ...receipt,
                artifacts: [
                    {
                        path: 'assets/android-pairing.png',
                        sha256: createHash('sha256').update(image).digest('hex'),
                        source: 'android-framebuffer',
                        type: 'screenshot',
                    },
                ],
            }),
        );
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });

        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({
                ...receipt,
                artifacts: [
                    {
                        path: 'assets/android-pairing.png',
                        sha256: '0'.repeat(64),
                        source: 'android-framebuffer',
                        type: 'screenshot',
                    },
                ],
            }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile media evidence is not device-bound',
        );
    });

    it('finalizes a mobile case blocked before the target ever ran', async () => {
        const directory = await reportDirectory();
        const caseId = 'ios-pairing-no-driver';
        const mobilePlan = {
            category: '移动端配对',
            expected: 'iOS 模拟器显示配对入口。',
            id: caseId,
            method: '使用指定 iOS 模拟器检查配对入口。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'simulator-udid',
                platform: 'ios',
            },
            requiredEvidence: ['screenshot'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: 'iOS 模拟器配对入口',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const covering = 'assets/covering-tests.txt';
        result.cases[0] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList([covering]),
            id: caseId,
            name: mobilePlan.title,
            observation: '本轮没有可用的 iOS 模拟器，断言由最窄拥有层的单元测试覆盖。',
            status: 'blocked',
            surface: 'mobile',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, covering), '覆盖该用例断言的单元测试：7 passed / 0 failed\n'),
        ]);

        /**
         * No simulator ever came up, so there is neither a device receipt nor a launch lifecycle to read. Demanding
         * either would leave an honest blocked mobile case unpublishable.
         */
        const finalized = await finalizeReport({ directory, requirement });
        expect(finalized.summary).toMatchObject({ blocked: 1, verdict: 'partial' });
    });

    it('finalizes blocked mobile evidence and rejects a mismatched outcome status', async () => {
        const directory = await reportDirectory();
        const caseId = 'ios-pairing-blocked';
        const mobilePlan = {
            category: '移动端配对',
            expected: 'iOS 模拟器显示配对入口。',
            id: caseId,
            method: '使用指定 iOS 模拟器检查配对入口。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'simulator-udid',
                platform: 'ios',
            },
            requiredEvidence: ['text'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: 'iOS 模拟器配对入口',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycle = await writeIsolatedLifecycle(directory, caseId, false);
        const deviceEvidence = `assets/${caseId}-mobile-device.json`;
        result.cases[0] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList([deviceEvidence, lifecycle.evidence]),
            id: caseId,
            name: mobilePlan.title,
            observation: '当前环境没有可用的原生触摸驱动，交互验收被阻断。',
            status: 'blocked',
            surface: 'mobile',
        };
        const receipt = {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'unavailable', mode: 'release' },
            caseId,
            cleanup: { appData: 'preserved', desktopProfile: 'not-started' },
            device: { id: 'simulator-udid', kind: 'simulator', platform: 'ios' },
            outcome: 'acceptance-run-blocked-before-device-ready',
            launchId: lifecycle.launchId,
            schemaVersion: 1,
            sourceCommit: reportCommit,
            status: 'blocked',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(receipt)),
        ]);

        const finalized = await finalizeReport({ directory, requirement });
        expect(finalized.summary).toMatchObject({ blocked: 1, verdict: 'partial' });

        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({ ...receipt, outcome: 'acceptance-run-failed', status: 'failed' }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile device receipt does not match the frozen plan',
        );
    });

    it('keeps a passed device outcome partial when planned progress evidence is missing', async () => {
        const directory = await reportDirectory();
        const caseId = 'android-session-progress';
        const mobilePlan = {
            category: '移动端 Session',
            expected: '新 Session 的创建进度可见。',
            id: caseId,
            method: '在指定 Android 模拟器上创建 Session 并观察进度。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'emulator-5554',
                platform: 'android',
            },
            requiredEvidence: ['screenshot'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: 'Android 新 Session 创建进度',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycle = await writeIsolatedLifecycle(directory, caseId);
        const deviceEvidence = `assets/${caseId}-mobile-device.json`;
        const observationEvidence = 'assets/session-progress-observation.txt';
        const blockedCase = {
            blockedReason: 'plan-evidence-gap',
            category: mobilePlan.category,
            evidence: citeEvidenceList([deviceEvidence, lifecycle.evidence, observationEvidence]),
            id: caseId,
            name: mobilePlan.title,
            observation:
                '设备成功创建新 Session，但录制从完成后的页面开始，缺少计划要求的创建进度画面。',
            status: 'blocked',
            surface: 'mobile',
        };
        const deviceReceipt = {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'apk-sha256', mode: 'release' },
            caseId,
            cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
            device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
            launchId: lifecycle.launchId,
            outcome: 'session-created-after-progress-state-was-missed',
            schemaVersion: 1,
            sourceCommit: reportCommit,
            status: 'passed',
        };
        result.cases[0] = blockedCase;
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(deviceReceipt)),
            writeFile(
                join(directory, observationEvidence),
                'Session was created, but the progress state was not captured.\n',
            ),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { blocked: 1, passed: 0, verdict: 'partial' },
        });

        result.cases[0] = {
            ...blockedCase,
            observation: '验收被阻断。',
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'plan-evidence-gap needs a concrete observation and supporting evidence',
        );

        result.cases[0] = {
            ...blockedCase,
            evidence: citeEvidenceList([deviceEvidence, lifecycle.evidence]),
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'plan-evidence-gap needs a concrete observation and supporting evidence',
        );

        result.cases[0] = { ...blockedCase, blockedReason: undefined };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile device receipt does not match the frozen plan',
        );

        result.cases[0] = { ...blockedCase, status: 'pass' };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'plan-evidence-gap is only valid for a blocked mobile case',
        );

        result.cases[0] = blockedCase;
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({ ...deviceReceipt, sourceCommit: 'b'.repeat(40) }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile device receipt does not match the frozen plan',
        );

        await writeFile(join(directory, deviceEvidence), JSON.stringify(deviceReceipt));
        await rm(join(directory, deviceEvidence));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'Evidence file does not exist',
        );

        const screenshotEvidence = 'assets/session-created.png';
        result.cases[0] = {
            ...blockedCase,
            evidence: citeEvidenceList([
                deviceEvidence,
                lifecycle.evidence,
                observationEvidence,
                screenshotEvidence,
            ]),
        };
        const receiptWithMedia = {
            ...deviceReceipt,
            artifacts: [
                {
                    path: screenshotEvidence,
                    sha256: createHash('sha256').update(VALID_PNG).digest('hex'),
                    source: 'android-framebuffer',
                    type: 'screenshot',
                },
            ],
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(receiptWithMedia)),
            writeFile(join(directory, screenshotEvidence), VALID_PNG),
        ]);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { blocked: 1, verdict: 'partial' },
        });
        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({
                ...receiptWithMedia,
                artifacts: [{ ...receiptWithMedia.artifacts[0], sha256: '0'.repeat(64) }],
            }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile media evidence is not device-bound',
        );
    });

    it('binds a ready Terminal preflight to the exact report commit and final launch', async () => {
        const directory = await reportDirectory();
        const caseId = 'android-terminal-grid';
        const mobilePlan = {
            category: '移动端终端',
            expected: '合成终端网格完整显示。',
            fixturePreflight: 'terminal',
            id: caseId,
            method: '在指定安卓模拟器上检查合成终端。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'emulator-5554',
                platform: 'android',
            },
            requiredEvidence: ['text'],
            stateIsolation: { mode: 'isolated' },
            surface: 'mobile',
            title: '安卓合成终端网格完整显示',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycle = await writeIsolatedLifecycle(directory, caseId);
        const deviceEvidence = `assets/${caseId}-mobile-device.json`;
        const preflightEvidence = `assets/${caseId}-fixture-preflight.json`;
        result.cases[0] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList([
                lifecycle.evidence,
                deviceEvidence,
                preflightEvidence,
                'assets/terminal-observation.txt',
            ]),
            id: caseId,
            name: mobilePlan.title,
            observation: '合成网格已准备就绪，设备显示完整菜单。',
            status: 'pass',
            surface: 'mobile',
        };
        const preflight = createTerminalFixturePreflightReceipt(
            {
                columns: 8,
                domRowCount: 1,
                firstGridMarker: { columns: 8, generation: 'grid-1', rows: 1 },
                generation: 'grid-1',
                lines: ['│12345 │'],
                rows: 1,
            },
            caseId,
            { launchId: lifecycle.launchId, sourceCommit: reportCommit },
        );
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(
                join(directory, deviceEvidence),
                JSON.stringify({
                    appId: 'com.caxri.mobile',
                    artifacts: [],
                    build: { identity: 'apk-sha256', mode: 'release' },
                    caseId,
                    cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
                    device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
                    launchId: lifecycle.launchId,
                    outcome: 'synthetic-grid-visible',
                    schemaVersion: 1,
                    sourceCommit: reportCommit,
                    status: 'passed',
                }),
            ),
            writeFile(join(directory, preflightEvidence), JSON.stringify(preflight)),
            writeFile(
                join(directory, 'assets/terminal-observation.txt'),
                'Synthetic grid observed.',
            ),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });
        await writeFile(
            join(directory, preflightEvidence),
            JSON.stringify({ ...preflight, sourceCommit: 'b'.repeat(40) }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'fixture preflight does not match the report commit or final launch',
        );
        await writeFile(
            join(directory, preflightEvidence),
            JSON.stringify({ ...preflight, launchId: 'stale-launch' }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'fixture preflight does not match the report commit or final launch',
        );
    });

    it('finalizes a readonly iOS checkpoint without a lifecycle launch receipt', async () => {
        const directory = await reportDirectory();
        const caseId = 'ios-static-layout';
        const checkpointId = 'ios-simulator-static-layout-1';
        const mobilePlan = {
            category: '移动端布局',
            expected: 'iOS 模拟器静态布局不发生裁切。',
            id: caseId,
            method: '在指定 iOS 模拟器检查不改变产品状态的静态布局。',
            mobileDevice: {
                appId: 'com.caxri.mobile',
                deviceId: 'simulator-udid',
                platform: 'ios',
            },
            requiredEvidence: ['text'],
            stateIsolation: { checkpointId, mode: 'readonly_checkpoint' },
            surface: 'mobile',
            title: 'iOS 模拟器静态布局',
            verifier: 'agent',
        } satisfies InitializeReportInput['plan'][number];
        await initialize(directory, [mobilePlan]);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const deviceEvidence = `assets/${caseId}-mobile-device.json`;
        result.cases[0] = {
            category: mobilePlan.category,
            evidence: citeEvidenceList([deviceEvidence, 'assets/ios-static-layout.txt']),
            id: caseId,
            name: mobilePlan.title,
            observation: '指定 iOS 模拟器的静态布局没有裁切。',
            status: 'pass',
            surface: 'mobile',
        };
        const receipt = {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'ios-app-sha256', mode: 'release' },
            caseId,
            checkpointId,
            cleanup: { appData: 'preserved', desktopProfile: 'not-used' },
            device: { id: 'simulator-udid', kind: 'simulator', platform: 'ios' },
            outcome: 'static-layout-observed-without-product-mutation',
            schemaVersion: 1,
            sourceCommit: reportCommit,
            status: 'passed',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, deviceEvidence), JSON.stringify(receipt)),
            writeFile(join(directory, 'assets/ios-static-layout.txt'), 'Static layout observed.'),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });

        await writeFile(
            join(directory, deviceEvidence),
            JSON.stringify({ ...receipt, checkpointId: 'stale-checkpoint' }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'mobile device receipt does not match the frozen plan',
        );
    });
});
