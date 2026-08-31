import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { InitializeReportInput } from './report';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    finalizeReport,
    initializeReport,
    markCaseLifecycleReady,
} from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-mobile-report-${process.pid}`,
);
const acceptanceRoots: string[] = [];
const requirement = 'Caxri 移动端应安全连接并呈现配对的 Agent Sessions。';
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
    return initializeReport({
        directory,
        entry: '在指定移动设备上执行隔离验收。',
        plan,
        requirement,
        title: '验收 Caxri 移动端',
    });
}

async function writeIsolatedLifecycle(
    directory: string,
    caseId: string,
    isReady = true,
): Promise<string> {
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
    return `assets/${encodeURIComponent(caseId)}-state-isolation.json`;
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
            evidence: ['assets/terminal.png', 'assets/terminal-dom.html', desktopLifecycle],
            id: desktopPlan.id,
            name: desktopPlan.title,
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        result.cases[1] = {
            category: mobilePlan.category,
            evidence: ['assets/android-short-reply-mobile-device.json', mobileLifecycle],
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
                    build: { identity: 'apk-sha256', mode: 'release' },
                    caseId: mobilePlan.id,
                    cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
                    device: { id: 'emulator-5554', kind: 'emulator', platform: 'android' },
                    outcome: 'one-bounded-reply-reached-the-waiting-agent',
                    schemaVersion: 1,
                    status: 'passed',
                }),
            ),
        ]);

        const finalized = await finalizeReport({ directory, requirement });
        expect(finalized.surfaces).toEqual(['desktop', 'mobile']);
        expect(finalized.cases.map(({ surface }) => surface)).toEqual(['desktop', 'mobile']);
        expect(finalized.summary.conclusion).toBe('当前 PR 头提交满足全部计划中的验收项。');
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
            evidence: ['assets/android-pairing.png', lifecycle],
            id: caseId,
            name: mobilePlan.title,
            observation: 'Android 发布构建显示了配对入口。',
            status: 'pass',
            surface: 'mobile',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/android-pairing.png'), 'image'),
        ]);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'must include its mobile device receipt',
        );
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
            evidence: [deviceEvidence, lifecycle],
            id: caseId,
            name: mobilePlan.title,
            observation: '当前环境没有可用的原生触摸驱动，交互验收被阻断。',
            status: 'blocked',
            surface: 'mobile',
        };
        const receipt = {
            appId: 'com.caxri.mobile',
            build: { identity: 'unavailable', mode: 'release' },
            caseId,
            cleanup: { appData: 'preserved', desktopProfile: 'not-started' },
            device: { id: 'simulator-udid', kind: 'simulator', platform: 'ios' },
            outcome: 'acceptance-run-blocked-before-device-ready',
            schemaVersion: 1,
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
});
