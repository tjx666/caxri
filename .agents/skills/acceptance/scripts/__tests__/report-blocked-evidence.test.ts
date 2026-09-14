import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from '../case-lifecycle';
import { finalizeReport, initializeReport } from '../report';
import { PROJECT_ROOT } from '../report-paths';

const REQUIREMENT =
    '验证一个用例在无法取证时仍能如实记录为 blocked，并且真正跑过的用例不能少申报收据。';
const PLAN: Parameters<typeof initializeReport>[0]['plan'] = [
    {
        category: '侧边栏',
        expected: '打开的标签在八个预设下都能看出来',
        id: 'ran-case',
        method: '在隔离实例里打开两个标签并截图',
        requiredEvidence: ['screenshot'],
        title: '标签在预设之间保持可辨',
    },
    {
        category: '终端',
        expected: '链接提示在新输出刷过后不消失',
        id: 'blocked-case',
        method: '在隔离实例里持续输出并录制链接提示',
        requiredEvidence: ['gif'],
        title: '终端链接提示不被新输出冲掉',
    },
];

const round = { directory: '', parent: '' };

async function seedRound(): Promise<void> {
    await initializeReport({
        commit: '0'.repeat(40),
        directory: round.directory,
        entry: '从设置里切换主题预设',
        plan: PLAN,
        requirement: REQUIREMENT,
        title: '验收 blocked 用例的取证契约',
    });
    await writeFile(
        join(round.directory, 'assets', 'ran-case.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeFile(
        join(round.directory, 'assets', 'covering-tests.txt'),
        '覆盖该用例断言的单元测试：11 passed / 0 failed\n',
        'utf8',
    );
}

/**
 * Writes the launch receipt the launcher would have produced for a case that actually ran.
 */
async function recordLaunch(caseId: string): Promise<void> {
    const launchId = await beginCaseLifecycle(round.directory, {
        caseId,
        profileIdentity: `caxri-acceptance-user-${caseId}`,
        stateIsolation: { mode: 'isolated' },
    });
    await markCaseLifecycleReady(round.directory, { caseId, launchId });
    await completeCaseLifecycle(round.directory, {
        caseId,
        cleanupCompleted: true,
        cleanupRequested: true,
        launchId,
    });
}

async function writeCases(
    cases: Array<{ evidence: string[]; id: string; status: 'pass' | 'fail' | 'blocked' }>,
): Promise<void> {
    const path = join(round.directory, 'result.json');
    const report = JSON.parse(await readFile(path, 'utf8')) as {
        cases: Array<{ evidence: string[]; id: string; observation: string; status: string }>;
    };
    for (const item of report.cases) {
        const update = cases.find(({ id }) => id === item.id);
        if (!update) continue;
        item.status = update.status;
        item.evidence = update.evidence;
        item.observation =
            update.status === 'blocked'
                ? '本轮未执行：断言已由本批提交的单元测试在最窄的拥有层覆盖。'
                : '实测通过，激活标签与未激活标签的底色和文字都能区分。';
    }
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

describe('finalizeReport blocked-case evidence contract', () => {
    beforeEach(async () => {
        // The report paths refuse anything outside `.records/`, so the fixture round lives there
        // too; `.records/` is gitignored and the whole temporary parent is removed afterwards.
        const root = join(PROJECT_ROOT, '.records', 'acceptance');
        await mkdir(root, { recursive: true });
        round.parent = await mkdtemp(join(root, 'report-contract-test-'));
        round.directory = join(round.parent, 'round-1');
    });

    afterEach(async () => {
        await rm(round.parent, { force: true, recursive: true });
    });

    it('finalizes a blocked case that never launched, using the evidence it does have', async () => {
        await seedRound();
        await recordLaunch('ran-case');
        await writeCases([
            {
                evidence: ['assets/ran-case.png', 'assets/ran-case-state-isolation.json'],
                id: 'ran-case',
                status: 'pass',
            },
            { evidence: ['assets/covering-tests.txt'], id: 'blocked-case', status: 'blocked' },
        ]);

        const finalized = await finalizeReport({
            directory: round.directory,
            requirement: REQUIREMENT,
        });

        expect(finalized.summary).toMatchObject({
            blocked: 1,
            failed: 0,
            passed: 1,
            total: 2,
            verdict: 'partial',
        });
    });

    it('still rejects a blocked case whose launch receipt exists but was not declared', async () => {
        await seedRound();
        await recordLaunch('ran-case');
        await recordLaunch('blocked-case');
        await writeCases([
            {
                evidence: ['assets/ran-case.png', 'assets/ran-case-state-isolation.json'],
                id: 'ran-case',
                status: 'pass',
            },
            { evidence: ['assets/covering-tests.txt'], id: 'blocked-case', status: 'blocked' },
        ]);

        await expect(
            finalizeReport({ directory: round.directory, requirement: REQUIREMENT }),
        ).rejects.toThrow('Case blocked-case must include its state-isolation receipt');
    });

    it('still requires the planned medium for a passing case', async () => {
        await seedRound();
        await recordLaunch('ran-case');
        await writeCases([
            { evidence: ['assets/covering-tests.txt'], id: 'ran-case', status: 'pass' },
            { evidence: ['assets/covering-tests.txt'], id: 'blocked-case', status: 'blocked' },
        ]);

        await expect(
            finalizeReport({ directory: round.directory, requirement: REQUIREMENT }),
        ).rejects.toThrow('Case ran-case is missing required evidence: screenshot');
    });

    it('names the missing launch receipt for a passing case instead of a bare ENOENT', async () => {
        await seedRound();
        await writeCases([
            { evidence: ['assets/ran-case.png'], id: 'ran-case', status: 'pass' },
            { evidence: ['assets/covering-tests.txt'], id: 'blocked-case', status: 'blocked' },
        ]);

        await expect(
            finalizeReport({ directory: round.directory, requirement: REQUIREMENT }),
        ).rejects.toThrow('Case ran-case must include its state-isolation receipt');
    });

    it('rejects a blocked case whose only evidence is a lifecycle receipt', async () => {
        await seedRound();
        await recordLaunch('ran-case');
        await recordLaunch('blocked-case');
        await writeCases([
            {
                evidence: ['assets/ran-case.png', 'assets/ran-case-state-isolation.json'],
                id: 'ran-case',
                status: 'pass',
            },
            {
                evidence: ['assets/blocked-case-state-isolation.json'],
                id: 'blocked-case',
                status: 'blocked',
            },
        ]);

        await expect(
            finalizeReport({ directory: round.directory, requirement: REQUIREMENT }),
        ).rejects.toThrow(
            'Case blocked-case is blocked and must cite evidence beyond its lifecycle receipts',
        );
    });
});
