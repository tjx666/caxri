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

const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-round-files-${process.pid}`,
);
const acceptanceRoots: string[] = [];
const requirement = 'Caxri 终端应完整填满工作区。';
const plan = [
    {
        category: '终端布局',
        expected: '终端视口周围不出现应用背景色条。',
        id: 'terminal-layout',
        method: '启动隔离的 Caxri 并检查稳定后的终端布局。',
        requiredEvidence: ['screenshot', 'dom_snapshot'],
        surface: 'desktop',
        title: '终端内容填满工作区',
        verifier: 'agent',
    },
] satisfies InitializeReportInput['plan'];

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
        entry: '在 Caxri Electron 中打开首个 Session 终端。',
        plan: [...plan],
        requirement,
        title: '验收 Caxri 终端布局',
    });
    const launchId = await beginCaseLifecycle(directory, {
        caseId: 'terminal-layout',
        profileIdentity: 'profile-terminal-layout',
        stateIsolation: { mode: 'isolated' },
    });
    await markCaseLifecycleReady(directory, { caseId: 'terminal-layout', launchId });
    await completeCaseLifecycle(directory, {
        caseId: 'terminal-layout',
        cleanupCompleted: true,
        cleanupRequested: true,
        launchId,
    });
    await Promise.all([
        writeFile(join(directory, 'assets/terminal.png'), 'image'),
        writeFile(join(directory, 'assets/terminal-dom.html'), '<main>terminal</main>'),
    ]);
    return JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as ReportFixture;
}

const CASE_PATHS = [
    'assets/terminal.png',
    'assets/terminal-dom.html',
    'assets/terminal-layout-state-isolation.json',
];

async function writeCase(
    directory: string,
    report: ReportFixture,
    evidence: unknown,
): Promise<void> {
    report.cases[0] = {
        category: '终端布局',
        evidence,
        id: 'terminal-layout',
        name: '终端内容填满工作区',
        observation: '终端视口周围没有露出应用背景。',
        status: 'pass',
        surface: 'desktop',
    };
    await writeFile(join(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('Acceptance round files', () => {
    it('scaffolds a proposal placeholder and refuses to finalize until it is replaced', async () => {
        const directory = await reportDirectory();
        const report = await seedRound(directory);
        await writeCase(directory, report, citeEvidenceList(CASE_PATHS));

        const proposalPath = join(directory, 'proposal.md');
        expect(await readFile(proposalPath, 'utf8')).toBe(
            '待补充：本轮交付了什么，希望评审者重点看哪里。\n',
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'proposal.md still holds the scaffold placeholder',
        );

        await writeFile(proposalPath, 'Reviewer notes for this round.\n');
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'proposal.md line 1 must be primarily Chinese',
        );

        await writeProposal(directory);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });
    });

    it('requires a reviewer-facing Chinese description on every cited artifact', async () => {
        const directory = await reportDirectory();
        const report = await seedRound(directory);
        await writeProposal(directory);

        await writeCase(directory, report, CASE_PATHS);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow('expected object');

        await writeCase(
            directory,
            report,
            CASE_PATHS.map((path) => ({ path })),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow('expected string');

        await writeCase(
            directory,
            report,
            CASE_PATHS.map((path) => ({ description: 'Terminal layout', path })),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'cases.0.evidence.0.description must be primarily Chinese',
        );

        await writeCase(directory, report, citeEvidenceList(CASE_PATHS));
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });
    });
});
