import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from '../case-lifecycle';
import type { InitializeReportInput } from '../report';
import { finalizeReport, initializeReport } from '../report';
import { PROJECT_ROOT } from '../report-paths';
import { citeEvidenceList, writeProposal } from './evidence-fixture';

const TEST_ROOT = join(PROJECT_ROOT, '.records', '__test__', `acceptance-cli-${process.pid}`);
const acceptanceRoots: string[] = [];
const requirement = 'Caxri CLI 应在选定的隔离 Profile 上返回稳定的 Project 列表。';
const cliPlan = {
    category: 'CLI 只读查询',
    expected: '命令返回当前 Profile 已添加的 Project 列表，不包含开发者常驻数据。',
    id: 'cli-project-list',
    method: '对隔离启动的 Profile 目录运行 CLI 的只读 Project 查询并保存输出。',
    requiredEvidence: ['text'],
    stateIsolation: { mode: 'isolated' },
    surface: 'cli',
    title: 'CLI 列出当前 Profile 的 Project',
    verifier: 'program',
} satisfies InitializeReportInput['plan'][number];

interface ReportFixture {
    cases: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

async function reportDirectory(): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    acceptanceRoots.push(root);
    return join(root, 'round-1');
}

async function seedRound(directory: string): Promise<ReportFixture> {
    await initializeReport({
        directory,
        entry: '在隔离 Profile 上运行 caxri CLI。',
        plan: [cliPlan],
        requirement,
        title: '验收 Caxri CLI 只读查询',
    });
    const launchId = await beginCaseLifecycle(directory, {
        caseId: cliPlan.id,
        profileIdentity: 'profile-cli-project-list',
        stateIsolation: { mode: 'isolated' },
    });
    await markCaseLifecycleReady(directory, { caseId: cliPlan.id, launchId });
    await completeCaseLifecycle(directory, {
        caseId: cliPlan.id,
        cleanupCompleted: true,
        cleanupRequested: true,
        launchId,
    });
    await writeFile(join(directory, 'assets/cli-project-list.json'), '{"projects":[]}');
    await writeProposal(
        directory,
        '本轮交付 CLI Project 查询，请重点看 --profile 是否只读到隔离数据。',
    );
    return JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as ReportFixture;
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('Acceptance CLI surface', () => {
    it('carries a cli case through finalize with its stdout artifact', async () => {
        const directory = await reportDirectory();
        const report = await seedRound(directory);
        report.cases[0] = {
            category: cliPlan.category,
            evidence: citeEvidenceList([
                'assets/cli-project-list.json',
                'assets/cli-project-list-state-isolation.json',
            ]),
            id: cliPlan.id,
            name: cliPlan.title,
            observation: '命令返回了该 Profile 的空 Project 列表，没有读到开发者常驻数据。',
            status: 'pass',
            surface: 'cli',
        };
        await writeFile(join(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);

        const finalized = await finalizeReport({ directory, requirement });
        expect(finalized.surfaces).toEqual(['cli']);
        expect(finalized.summary).toMatchObject({ passed: 1, verdict: 'pass' });
    });

    it('refuses a cli plan item that declares a mobile device', async () => {
        const directory = await reportDirectory();
        await expect(
            initializeReport({
                directory,
                entry: '在隔离 Profile 上运行 caxri CLI。',
                plan: [
                    {
                        ...cliPlan,
                        mobileDevice: {
                            appId: 'com.caxri.mobile',
                            deviceId: 'emulator-5554',
                            platform: 'android',
                        },
                    },
                ],
                requirement,
                title: '验收 Caxri CLI 只读查询',
            }),
        ).rejects.toThrow('A cli Acceptance case cannot declare mobileDevice');
    });
});
