import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import type {
    AgentProvider,
    BenchmarkEntry,
    BenchmarkRun,
    BenchmarkSettings,
    ServerEvent,
} from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BenchmarkRunsModel, CaxriDatabase } from '../../db';
import { BenchmarkService } from '../service';

const FIXTURES = join(import.meta.dirname, '..', '..', 'agent-chat', '__tests__', 'fixtures');
const FAKE_CLIS: Record<AgentProvider, string> = {
    claude: join(FIXTURES, 'fake-claude-cli.ts'),
    codex: join(FIXTURES, 'fake-codex-app-server.ts'),
    grok: join(FIXTURES, 'fake-grok-acp.ts'),
    antigravity: join(FIXTURES, 'fake-antigravity-acp.ts'),
};

const CLAUDE: BenchmarkEntry = { provider: 'claude', model: 'fake-claude-model', effort: 'high' };
const CODEX: BenchmarkEntry = { provider: 'codex', model: 'fake-codex-model', effort: 'low' };
const GROK: BenchmarkEntry = { provider: 'grok', model: 'grok-fake' };

/**
 * A Benchmark service over a temporary database whose providers are the fake Codex, Claude Code, and Grok CLIs.
 */
async function fixture() {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-benchmark-`));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const claudeConfigDirectory = join(directory, 'claude');
    const events: ServerEvent[] = [];
    const logWrite = vi.fn<StructuredLogger['write']>();
    const create = () =>
        new BenchmarkService({
            database,
            logger: { write: logWrite } as unknown as StructuredLogger,
            send: (event) => events.push(event),
            userDataPath: directory,
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CLAUDE_CONFIG_DIR: claudeConfigDirectory },
            },
            environment: () =>
                Promise.resolve({
                    ...process.env,
                    FAKE_CODEX_STATE_DIR: join(directory, 'codex'),
                    FAKE_GROK_STATE_DIR: join(directory, 'grok'),
                    FAKE_ANTIGRAVITY_STATE_DIR: join(directory, 'antigravity'),
                    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
                    FAKE_CLAUDE_CONTROL_DIR: claudeConfigDirectory,
                }),
            resolveExecutable: (provider) => Promise.resolve(`/fake/${provider}`),
            launchSettings: (provider) => defaultAgentProviderSettings[provider].launch,
            clientVersion: '0.0.0-test',
            spawnProcess: (
                executable: string,
                arguments_: string[],
                options: SpawnOptionsWithoutStdio,
            ) =>
                spawn(
                    process.execPath,
                    [FAKE_CLIS[basename(executable) as AgentProvider], ...arguments_],
                    options,
                ),
            // Pricing stays on the bundled table instead of reaching the network.
            fetch: () => Promise.reject(new Error('offline')),
        });
    let service = create();
    onTestFinished(async () => {
        await service.shutdown();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const settings = (overrides: Partial<BenchmarkSettings> = {}): BenchmarkSettings => ({
        workspace: { kind: 'empty' },
        repeats: 1,
        concurrency: 3,
        timeoutMinutes: 5,
        ...overrides,
    });
    async function finished(runId: string): Promise<BenchmarkRun> {
        await vi.waitFor(() => expect(service.get(runId).status).not.toBe('running'), {
            timeout: 20_000,
            interval: 25,
        });
        return service.get(runId);
    }
    return {
        directory,
        database,
        events,
        logWrite,
        settings,
        finished,
        get service() {
            return service;
        },
        /**
         * Stands in for a Server restart: a new service over the same database.
         */
        restart() {
            service = create();
            return service;
        },
    };
}

describe('BenchmarkService', () => {
    it('runs every Entry and measures the transcript that has usage', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CLAUDE, CODEX, GROK],
            settings: harness.settings(),
        });
        const run = await harness.finished(runId);

        expect(run.status).toBe('completed');
        expect(run.attempts.map((attempt) => attempt.status)).toEqual([
            'completed',
            'completed',
            'completed',
        ]);
        const [claude, codex, grok] = run.attempts;
        expect(claude.finalText).toContain('Say hello');
        expect(claude.durationMs).toBeGreaterThan(0);
        expect(claude.tokens?.total).toBeGreaterThan(0);
        expect(claude.diff).toEqual({ files: 0, additions: 0, deletions: 0 });
        // Neither fake writes a usage transcript, so usage stays unknown instead of reading as free.
        for (const attempt of [codex, grok]) {
            expect(attempt.finalText).toContain('Say hello');
            expect(attempt.tokens).toBeUndefined();
            expect(attempt.costUsd).toBeUndefined();
        }
        // Every driver reports first output, context usage, and compactions through the Chat stream.
        for (const attempt of run.attempts) {
            expect(attempt.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
            expect(attempt.compactions).toBe(0);
            expect(attempt.context?.peakTokens).toBeGreaterThan(0);
            expect(attempt.context?.window).toBeGreaterThan(0);
        }
        // Generation time comes from the transcript, which only the Claude fake writes.
        expect(claude.generation).toMatchObject({ outputTokens: 40, responses: 1 });
        expect(codex.generation).toBeUndefined();
        expect(run.pricing?.source).toBe('bundled');
        expect(new BenchmarkRunsModel(harness.database.database).get(runId)?.status).toBe(
            'completed',
        );
        // The final publish is a transition, so the history list re-reads it; every event states its kind.
        expect(harness.events.at(-1)).toEqual({
            event: 'benchmark.changed',
            payload: { runId, kind: 'transition' },
        });
        expect(
            harness.events.every(
                (event) =>
                    event.event !== 'benchmark.changed' ||
                    event.payload.kind === 'progress' ||
                    event.payload.kind === 'transition',
            ),
        ).toBe(true);
        expect(harness.service.list().runs).toMatchObject([
            { id: runId, title: 'Say hello', attempts: 3, completedAttempts: 3 },
        ]);
    });

    it('applies the Antigravity model and effort after start, since agy acp takes no model flag', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [{ provider: 'antigravity', model: 'gemini-fake-pro', effort: 'low' }],
            settings: harness.settings(),
        });
        const [attempt] = (await harness.finished(runId)).attempts;
        expect(attempt.status).toBe('completed');
        expect(attempt.finalText).toContain('(gemini-fake-pro, low)');
    });

    it('runs each Entry the requested number of times', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings({ repeats: 2, concurrency: 1 }),
        });
        const run = await harness.finished(runId);

        expect(run.attempts.map(({ repeat, status }) => ({ repeat, status }))).toEqual([
            { repeat: 1, status: 'completed' },
            { repeat: 2, status: 'completed' },
        ]);
    });

    it('records a provider that exits mid-turn as a failed Attempt with its reason', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'crash now',
            entries: [CLAUDE],
            settings: harness.settings(),
        });
        const run = await harness.finished(runId);

        expect(run.status).toBe('completed');
        expect(run.attempts[0]).toMatchObject({ status: 'failed', failureReason: 'processExited' });
    });

    it('records a failed turn and still finishes the run', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'please fail',
            entries: [CODEX],
            settings: harness.settings(),
        });
        const run = await harness.finished(runId);

        expect(run.attempts[0]).toMatchObject({ status: 'failed', failureReason: 'turnFailed' });
    });

    it('cancels running and queued Attempts', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'go slow',
            entries: [CODEX, CODEX],
            settings: harness.settings({ concurrency: 1 }),
        });
        await vi.waitFor(
            () => expect(harness.service.get(runId).attempts[0].status).toBe('running'),
            {
                timeout: 10_000,
            },
        );
        expect(harness.service.liveCount()).toBe(2);
        harness.service.cancel(runId);
        const run = await harness.finished(runId);

        expect(run.status).toBe('cancelled');
        expect(run.attempts.map((attempt) => attempt.status)).toEqual(['cancelled', 'cancelled']);
        expect(harness.service.liveCount()).toBe(0);
    });

    it('never starts a queued Attempt the user stopped', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'go slow',
            entries: [CODEX, CODEX],
            settings: harness.settings({ concurrency: 1 }),
        });
        await vi.waitFor(
            () => expect(harness.service.get(runId).attempts[0].status).toBe('running'),
            { timeout: 10_000 },
        );
        const [first, second] = harness.service.get(runId).attempts;
        harness.service.cancel(runId, second.id);
        harness.service.cancel(runId, first.id);
        const run = await harness.finished(runId);

        expect(run.attempts.map((attempt) => attempt.status)).toEqual(['cancelled', 'cancelled']);
        expect(run.attempts[1].startedAt).toBeUndefined();
        expect(run.attempts[1].cliVersion).toBeUndefined();
    });

    it('records an Attempt stopped during its check as cancelled', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings({ checkCommand: 'sleep 30' }),
        });
        await vi.waitFor(
            () => expect(harness.service.get(runId).attempts[0].status).toBe('checking'),
            { timeout: 10_000 },
        );
        harness.service.cancel(runId, harness.service.get(runId).attempts[0].id);
        const run = await harness.finished(runId);

        expect(run.attempts[0].status).toBe('cancelled');
    });

    it('takes the diff of what the Agent changed and runs the check command in its folder', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings({ checkCommand: 'echo checked > proof.txt && exit 3' }),
        });
        const run = await harness.finished(runId);
        const [attempt] = run.attempts;

        expect(attempt.status).toBe('completed');
        expect(attempt.check).toMatchObject({ status: 'failed', exitCode: 3 });
        const { diff } = await harness.service.attemptDiff(runId, attempt.id);
        expect(diff).toContain('+checked');
    });

    it('starts a Project run from the Project commit without touching the Project', async () => {
        const harness = await fixture();
        const root = join(harness.directory, 'project');
        await mkdir(root);
        await writeFile(join(root, 'notes.txt'), 'original\n');
        const git = (...arguments_: string[]) =>
            execFileSync(
                'git',
                ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...arguments_],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ).trim();
        git('init', '--quiet');
        git('add', '--all');
        git('commit', '--quiet', '-m', 'Start');
        const project = harness.database.createProject(root);
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings({
                workspace: { kind: 'project', projectId: project.id },
                checkCommand: 'echo changed > notes.txt',
            }),
        });
        const run = await harness.finished(runId);
        const [attempt] = run.attempts;

        expect(run.baseCommit).toBe(git('rev-parse', 'HEAD'));
        expect(attempt).toMatchObject({ status: 'completed', check: { status: 'passed' } });
        const { diff } = await harness.service.attemptDiff(runId, attempt.id);
        expect(diff).toContain('-original\n+changed');
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('original\n');
        expect(git('status', '--porcelain')).toBe('');
    });

    it('runs a Project that is a subfolder of its repository inside that subfolder', async () => {
        const harness = await fixture();
        const repo = join(harness.directory, 'monorepo');
        const root = join(repo, 'packages', 'web');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'notes.txt'), 'original\n');
        await writeFile(join(repo, 'outside.txt'), 'outside\n');
        const git = (...arguments_: string[]) =>
            execFileSync(
                'git',
                ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...arguments_],
                { cwd: repo, encoding: 'utf8' },
            ).trim();
        git('init', '--quiet');
        git('add', '--all');
        git('commit', '--quiet', '-m', 'Start');
        const project = harness.database.createProject(root);
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings({
                workspace: { kind: 'project', projectId: project.id },
                // The check runs in the subfolder; the second write lands outside it and must stay out of the diff.
                checkCommand: 'echo changed > notes.txt && echo changed > ../../outside.txt',
            }),
        });
        const run = await harness.finished(runId);
        const [attempt] = run.attempts;

        expect(run.projectSubpath).toBe('packages/web');
        expect(attempt).toMatchObject({
            status: 'completed',
            check: { status: 'passed' },
        });
        const { diff } = await harness.service.attemptDiff(runId, attempt.id);
        expect(diff).toContain('-original\n+changed');
        expect(diff).not.toContain('outside.txt');
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('original\n');
        expect(git('status', '--porcelain')).toBe('');
    });

    it('closes the runs a previous Server left unfinished', async () => {
        const harness = await fixture();
        const runs = new BenchmarkRunsModel(harness.database.database);
        runs.save({
            id: 'interrupted',
            title: 'Say hello',
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings(),
            status: 'running',
            createdAt: Date.now(),
            attempts: [{ id: 'attempt', entryIndex: 0, repeat: 1, status: 'running', steps: 2 }],
        });
        const service = harness.restart();

        expect(service.get('interrupted')).toMatchObject({
            status: 'completed',
            attempts: [{ status: 'failed', failureReason: 'serverRestarted' }],
        });
    });

    it('deletes a run with its folder', async () => {
        const harness = await fixture();
        const { runId } = await harness.service.start({
            prompt: 'Say hello',
            entries: [CODEX],
            settings: harness.settings(),
        });
        await harness.finished(runId);
        await harness.service.delete(runId);

        expect(() => harness.service.get(runId)).toThrow('Benchmark run not found');
        expect(harness.service.list().runs).toEqual([]);
    });

    it('refuses to delete a run that does not exist, removing nothing', async () => {
        const harness = await fixture();
        const sentinel = join(harness.directory, 'keep.txt');
        await writeFile(sentinel, 'keep');

        await expect(harness.service.delete('../..')).rejects.toThrow('Benchmark run not found');
        expect(await readFile(sentinel, 'utf8')).toBe('keep');
    });

    it('lists the models each Agent offers', async () => {
        const harness = await fixture();
        const catalog = await harness.service.catalog();

        const byProvider = Object.fromEntries(
            catalog.providers.map((provider) => [provider.provider, provider]),
        );
        expect(byProvider.codex).toMatchObject({ status: 'ready' });
        expect(byProvider.codex.models.map((model) => model.id)).toContain('fake-codex-model');
        expect(byProvider.claude.models.map((model) => model.id)).toContain('fake-claude-model');
        // Grok lists its own efforts over ACP, so the Benchmark offers them as listed.
        expect(byProvider.grok.models[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    });
});
