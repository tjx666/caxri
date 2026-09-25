import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { citeEvidenceList, writeProposal } from './__tests__/evidence-fixture';
import {
    beginAgentFixtureLifecycle,
    completeAgentFixtureLifecycle,
    validateAgentFixtureEvidence,
} from './agent-fixture-lifecycle';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from './case-lifecycle';
import { createTerminalFixturePreflightReceipt } from './fixture-preflight';
import type { InitializeReportInput } from './report';
import {
    finalizeReport,
    initializeReport,
    rebindReportHead,
    validateAcceptanceCaseLaunch,
} from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The production path guard requires fixtures under the real project `.records/` root.
 */
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const TEST_ROOT = join(RECORDS_ROOT, '__test__', `acceptance-report-${process.pid}`);
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
        supersedes: ['legacy-terminal-layout'],
        title: '终端内容填满工作区',
        verifier: 'agent',
    },
] satisfies InitializeReportInput['plan'];

interface ReportFixture {
    cases: Array<Record<string, unknown>>;
    plan: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

function parseReport(raw: string): ReportFixture {
    const parsed: unknown = JSON.parse(raw);
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('cases' in parsed) ||
        !Array.isArray(parsed.cases) ||
        !('plan' in parsed) ||
        !Array.isArray(parsed.plan)
    ) {
        throw new Error('Invalid report fixture');
    }
    return parsed as ReportFixture;
}

async function reportDirectory(round = 1): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    acceptanceRoots.push(root);
    return join(root, `round-${round}`);
}

async function initialize(directory: string, input: Partial<InitializeReportInput> = {}) {
    const path = await initializeReport({
        directory,
        entry: '在 Caxri Electron 中打开首个 Session 终端。',
        plan: [...plan],
        requirement,
        title: '验收 Caxri 终端布局',
        ...input,
    });
    await writeProposal(directory);
    return path;
}

async function writeIsolatedLifecycle(directory: string, caseId = 'terminal-layout') {
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
    return `assets/${encodeURIComponent(caseId)}-state-isolation.json`;
}

async function writeAgentFixtureLifecycle(directory: string, caseId = 'terminal-layout') {
    const launchId = await beginAgentFixtureLifecycle(directory, {
        availableProviders: ['claude', 'codex'],
        caseId,
        fixtureId: 'agent-features-v1',
    });
    await completeAgentFixtureLifecycle(directory, {
        caseId,
        cleanupCompleted: true,
        launchId,
        sharedProfile: false,
    });
    return `assets/${encodeURIComponent(caseId)}-agent-fixture.json`;
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance report scaffold', () => {
    it('freezes only a repository-owned Agent fixture id in the plan', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], agentFixture: 'agent-features-v1' }],
        });

        const result = parseReport(await readFile(join(directory, 'result.json'), 'utf8'));
        expect(result.plan[0]).toMatchObject({ agentFixture: 'agent-features-v1' });

        const invalidDirectory = await reportDirectory();
        await expect(
            initialize(invalidDirectory, {
                plan: [
                    { ...plan[0], agentFixture: '../host-agent' },
                ] as unknown as InitializeReportInput['plan'],
            }),
        ).rejects.toThrow();
    });

    it('requires a cleaned fake Agent fixture receipt before finalizing a fixture case', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [
                {
                    ...plan[0],
                    agentFixture: 'agent-features-v1',
                    requiredEvidence: ['screenshot'],
                },
            ],
        });
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycleEvidence = await writeIsolatedLifecycle(directory);
        const fixtureEvidence = await writeAgentFixtureLifecycle(directory);
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList(['assets/terminal.png', lifecycleEvidence, fixtureEvidence]),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '固定假 Agent 在隔离配置中完成启动与清理。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });

        const receiptPath = join(directory, fixtureEvidence);
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
            launches: Array<{ cleanupCompleted: boolean }>;
        };
        receipt.launches[0].cleanupCompleted = false;
        await writeFile(receiptPath, JSON.stringify(receipt));
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'Agent fixture receipt does not match the frozen plan',
        );
    });

    it('records final restart cleanup against every shared Agent fixture launch', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], agentFixture: 'agent-features-v1' }],
        });
        const firstLaunchId = await beginAgentFixtureLifecycle(directory, {
            availableProviders: ['claude', 'codex'],
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            launchId: firstLaunchId,
            sharedProfile: true,
        });
        const finalLaunchId = await beginAgentFixtureLifecycle(directory, {
            availableProviders: ['claude', 'codex'],
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: true,
            launchId: finalLaunchId,
            sharedProfile: true,
        });

        const receipt = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-agent-fixture.json'), 'utf8'),
        ) as { launches: Array<{ cleanupCompleted: boolean }> };
        expect(receipt.launches).toHaveLength(2);
        expect(receipt.launches.every(({ cleanupCompleted }) => cleanupCompleted)).toBe(true);
    });

    it('does not credit an isolated retry with cleanup of an earlier fixture profile', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], agentFixture: 'agent-features-v1' }],
        });
        const firstLaunchId = await beginAgentFixtureLifecycle(directory, {
            availableProviders: ['claude', 'codex'],
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            launchId: firstLaunchId,
            sharedProfile: false,
        });
        const retryLaunchId = await beginAgentFixtureLifecycle(directory, {
            availableProviders: ['claude', 'codex'],
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: true,
            launchId: retryLaunchId,
            sharedProfile: false,
        });

        const receipt = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-agent-fixture.json'), 'utf8'),
        ) as { launches: Array<{ cleanupCompleted: boolean }> };
        expect(receipt.launches.map(({ cleanupCompleted }) => cleanupCompleted)).toEqual([
            false,
            true,
        ]);
    });

    it('rejects a symbolic-link Agent fixture receipt during completion and validation', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], agentFixture: 'agent-features-v1' }],
        });
        const launchId = await beginAgentFixtureLifecycle(directory, {
            availableProviders: ['claude', 'codex'],
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        const receiptPath = join(directory, 'assets/terminal-layout-agent-fixture.json');
        const targetPath = join(directory, 'assets/agent-fixture-target.json');
        await writeFile(targetPath, await readFile(receiptPath));
        await rm(receiptPath);
        await symlink(targetPath, receiptPath);

        await expect(
            completeAgentFixtureLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: true,
                launchId,
                sharedProfile: false,
            }),
        ).rejects.toThrow('must be a direct regular file');
        await expect(
            validateAgentFixtureEvidence(directory, {
                status: 'pass',
                caseId: 'terminal-layout',
                evidencePaths: ['assets/terminal-layout-agent-fixture.json'],
                fixtureId: 'agent-features-v1',
            }),
        ).rejects.toThrow('must be a direct regular file');
    });

    it('preserves an uppercase stable check id from the owning issue', async () => {
        const directory = await reportDirectory();

        await initialize(directory, {
            plan: [{ ...plan[0], id: 'MOB-SEC-01' }],
        });

        const result = parseReport(await readFile(join(directory, 'result.json'), 'utf8'));
        expect(result.plan[0]?.id).toBe('MOB-SEC-01');
        expect(result.cases[0]?.id).toBe('MOB-SEC-01');
    });

    it('rejects case ids that differ only by ASCII letter case', async () => {
        const directory = await reportDirectory();

        await expect(
            initialize(directory, {
                plan: [
                    { ...plan[0], id: 'MOB-SEC-01' },
                    { ...plan[0], id: 'mob-sec-01' },
                ],
            }),
        ).rejects.toThrow('Duplicate plan id ignoring ASCII letter case: mob-sec-01');
    });

    it('reports an actionable error for generated TODO placeholders', async () => {
        const directory = await reportDirectory();
        await initialize(directory);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'Case terminal-layout is still a TODO placeholder',
        );
    });

    it('initializes a Chinese report with visible case placeholders and a frozen requirement', async () => {
        const directory = await reportDirectory();

        await initialize(directory, {
            branch: 'fix/terminal-layout',
            commit: 'abc123',
            entry: '  在 Caxri Electron 中打开首个 Session 终端。  ',
            pullRequest: 42,
            title: '  验收 Caxri 终端布局  ',
        });

        const result = parseReport(await readFile(join(directory, 'result.json'), 'utf8'));
        expect(result).toMatchObject({
            cases: [{ id: 'terminal-layout', status: 'TODO' }],
            entry: '在 Caxri Electron 中打开首个 Session 终端。',
            pullRequest: { number: 42 },
            requirement,
            title: '验收 Caxri 终端布局',
        });
        expect(result.plan[0]).toMatchObject({ stateIsolation: { mode: 'isolated' } });
        expect(result).not.toHaveProperty('summary');
        await expect(access(join(directory, 'assets'))).resolves.toBeUndefined();
        const requirementPath = join(dirname(directory), 'requirement.txt');
        await expect(readFile(requirementPath, 'utf8')).resolves.toBe(`${requirement}\n`);
        await expect(readFile(join(directory, 'report.md'), 'utf8')).resolves.toBe(
            '本轮暂无补充说明。\n',
        );
    });

    it('atomically rebinds an unfinished round to an exact replacement head with an audit record', async () => {
        const directory = await reportDirectory();
        await initialize(directory, { commit: 'old-head' });

        await rebindReportHead({
            commit: 'new-head',
            createdAt: '2026-08-13T08:00:00.000Z',
            directory,
            entry: '在 new-head 上执行 Caxri Electron 桌面验收。',
            fromCommit: 'old-head',
            reason: 'Workflow-only repair changed the exact delivery head.',
        });

        const result = parseReport(await readFile(join(directory, 'result.json'), 'utf8'));
        expect(result).toMatchObject({
            commit: 'new-head',
            createdAt: '2026-08-13T08:00:00.000Z',
            entry: '在 new-head 上执行 Caxri Electron 桌面验收。',
            headRebinds: [
                {
                    fromCommit: 'old-head',
                    reason: 'Workflow-only repair changed the exact delivery head.',
                    reboundAt: '2026-08-13T08:00:00.000Z',
                    toCommit: 'new-head',
                },
            ],
        });
        expect(result.cases).toEqual([
            expect.objectContaining({ id: 'terminal-layout', status: 'TODO' }),
        ]);

        await expect(
            rebindReportHead({
                commit: 'another-head',
                directory,
                entry: '在 another-head 上执行 Caxri Electron 桌面验收。',
                fromCommit: 'stale-head',
                reason: 'Stale caller must fail closed.',
            }),
        ).rejects.toThrow('does not match --from-commit');
    });

    it('derives summary, verifies evidence coverage, and preserves supported extension fields', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycleEvidence = await writeIsolatedLifecycle(directory);
        result.cases[0] = {
            category: '终端布局',
            datasets: [{ fields: [{ key: 'gap', type: 'number' }], id: 'layout-gap', rows: [] }],
            evidence: citeEvidenceList([
                'assets/terminal.png',
                'assets/terminal-dom.html',
                lifecycleEvidence,
            ]),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            required: false,
            status: 'pass',
            suggestion: '保持当前终端布局实现。',
            surface: 'desktop',
            visualizations: [{ dataset: 'layout-gap', id: 'gap-table', type: 'table', version: 1 }],
        };
        result.summary = { score: 92, uncertain: 0 };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
            writeFile(join(directory, 'assets/terminal-dom.html'), '<main>terminal</main>'),
        ]);

        const conclusion = '本轮针对终端布局完成了专项桌面验收。';
        const finalized = await finalizeReport({ conclusion, directory, requirement });

        expect(finalized.summary).toEqual({
            blocked: 0,
            conclusion,
            failed: 0,
            passed: 1,
            score: 92,
            total: 1,
            uncertain: 0,
            verdict: 'pass',
        });
        expect(finalized.plan[0]).toMatchObject({
            surface: 'desktop',
            supersedes: ['legacy-terminal-layout'],
        });
        expect(finalized.cases[0]).toMatchObject({
            datasets: [{ id: 'layout-gap' }],
            required: false,
            suggestion: '保持当前终端布局实现。',
        });
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { conclusion },
        });
    });

    it('rejects missing required evidence before writing a summary', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList(['assets/terminal.png']),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
        ]);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'missing required evidence: dom_snapshot',
        );
        expect(parseReport(await readFile(resultPath, 'utf8'))).not.toHaveProperty('summary');
    });

    it('rejects case ids or labels that drift from the frozen plan', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList(['assets/terminal.png']),
            id: 'different-check',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'Case ids and order must exactly match the frozen plan',
        );

        result.cases[0].id = 'terminal-layout';
        result.cases[0].name = '被修改的检查名称';
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'title, category, and surface must match the frozen plan',
        );
    });

    it('rejects requirement drift between rounds and inside a round', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const secondRoundDirectory = join(dirname(directory), 'round-2');
        await expect(
            initialize(secondRoundDirectory, {
                requirement: 'Caxri 终端应完整填满整个工作区。',
            }),
        ).rejects.toThrow('must match the frozen requirement');

        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.requirement = 'Caxri 终端应完整填满整个工作区。';
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'must match the frozen requirement',
        );
    });

    it('rejects report directories outside .records or behind a symbolic link', async () => {
        await expect(initialize('/tmp/caxri-acceptance/round-1')).rejects.toThrow(
            'must stay under .records',
        );

        const directory = await reportDirectory();
        const root = dirname(directory);
        const target = join(root, 'target');
        await mkdir(target);
        await symlink(target, join(root, 'linked'), 'dir');
        await expect(initialize(join(root, 'linked', 'round-1'))).rejects.toThrow(
            'must not contain symbolic links',
        );
    });

    it('rejects evidence paths that normalize outside assets', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], requiredEvidence: ['screenshot'] }],
        });
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList(['assets/../outside.png']),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'outside.png'), 'image'),
        ]);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'must stay under assets',
        );
    });

    it('matches markdown evidence to the Caxri publication schema and rejects transcript plans', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], requiredEvidence: ['markdown'] }],
        });
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycleEvidence = await writeIsolatedLifecycle(directory);
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList(['assets/terminal-notes.md', lifecycleEvidence]),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal-notes.md'), '验收记录'),
        ]);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { verdict: 'pass' },
        });

        const nextDirectory = join(dirname(directory), 'round-2');
        const transcriptPlan = [
            { ...plan[0], requiredEvidence: ['transcript'] },
        ] as unknown as InitializeReportInput['plan'];
        await expect(initialize(nextDirectory, { plan: transcriptPlan })).rejects.toThrow(
            'Invalid option: expected one of',
        );
    });

    it('binds launch mode and restart profile identity to the frozen plan', () => {
        expect(() =>
            validateAcceptanceCaseLaunch(
                { mode: 'isolated' },
                {
                    caseMode: 'restart',
                    cleanupReusable: false,
                    reuseUserData: true,
                },
            ),
        ).toThrow('cannot reuse');
        expect(
            validateAcceptanceCaseLaunch(
                { cleanupOwner: 'final_launch', mode: 'restart', profileId: 'profile-1' },
                { caseMode: 'restart', cleanupReusable: true, reuseUserData: true },
            ),
        ).toEqual({ profileId: 'profile-1' });
    });

    it('allows an isolated case to retry after a cleaned launch that never became ready', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const failedLaunch = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'failed-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await completeCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: true,
            cleanupRequested: true,
            launchId: failedLaunch,
        });

        await expect(
            beginCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                profileIdentity: 'replacement-profile',
                stateIsolation: { mode: 'isolated' },
            }),
        ).resolves.toEqual(expect.any(String));
    });

    it('preserves cleaned ready attempts when an isolated case retries with a fresh profile', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [{ ...plan[0], requiredEvidence: ['screenshot'] }],
        });
        const firstLaunch = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'first-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await markCaseLifecycleReady(directory, {
            caseId: 'terminal-layout',
            launchId: firstLaunch,
        });
        await completeCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: true,
            cleanupRequested: true,
            launchId: firstLaunch,
        });

        await expect(
            beginCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                profileIdentity: 'first-profile',
                stateIsolation: { mode: 'isolated' },
            }),
        ).rejects.toThrow('fresh profile');

        const replacementLaunch = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'replacement-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await markCaseLifecycleReady(directory, {
            caseId: 'terminal-layout',
            launchId: replacementLaunch,
        });
        await completeCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: true,
            cleanupRequested: true,
            launchId: replacementLaunch,
        });

        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList([
                'assets/terminal.png',
                'assets/terminal-layout-state-isolation.json',
            ]),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '第二次隔离启动完成了终端布局观察。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
        ]);

        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { passed: 1, verdict: 'pass' },
        });

        const lifecycle = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-state-isolation.json'), 'utf8'),
        ) as { launches: Array<{ profileIdentity: string }> };
        expect(lifecycle.launches.map(({ profileIdentity }) => profileIdentity)).toEqual([
            'first-profile',
            'replacement-profile',
        ]);
    });

    it('blocks a Terminal fixture verdict without a ready preflight receipt', async () => {
        const directory = await reportDirectory();
        await initialize(directory, {
            plan: [
                {
                    ...plan[0],
                    fixturePreflight: 'terminal',
                    requiredEvidence: ['screenshot'],
                },
            ],
        });
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        const lifecycleEvidence = await writeIsolatedLifecycle(directory);
        const preflightEvidence = 'assets/terminal-layout-fixture-preflight.json';
        result.cases[0] = {
            category: '终端布局',
            evidence: citeEvidenceList([
                'assets/terminal.png',
                lifecycleEvidence,
                preflightEvidence,
            ]),
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
            status: 'pass',
            surface: 'desktop',
        };
        const mismatchedPreflightReceipt = createTerminalFixturePreflightReceipt(
            {
                columns: 8,
                domRowCount: 1,
                firstGridMarker: { columns: 8, generation: 'fixture-1', rows: 1 },
                generation: 'fixture-1',
                lines: ['│中🙂   │'],
                rows: 1,
            },
            'terminal-layout',
        );
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
            writeFile(
                join(directory, preflightEvidence),
                JSON.stringify(mismatchedPreflightReceipt),
            ),
        ]);

        await expect(finalizeReport({ directory, requirement })).rejects.toThrow(
            'fixture preflight is blocked',
        );

        const forged = createTerminalFixturePreflightReceipt(
            {
                columns: 8,
                domRowCount: 1,
                firstGridMarker: { columns: 8, generation: 'fixture-2', rows: 1 },
                generation: 'fixture-2',
                lines: ['│12345 │'],
                rows: 1,
            },
            'terminal-layout',
        );
        await writeFile(
            join(directory, preflightEvidence),
            JSON.stringify({ ...forged, fixture: { ...forged.fixture, lines: ['│中🙂   │'] } }),
        );
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow();
    });
});
