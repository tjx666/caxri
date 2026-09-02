import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary, ServerEvent, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeTranscriptPath } from '../agents/providers/claude/paths';
import type { ProjectStatusRunner } from '../project-status-external';
import { ProjectStatusCliError } from '../project-status-external';
import { selectBranchPullRequest, SessionPullRequestService } from '../session-pull-requests';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = loggers.slice();
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((instance) => instance.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function logger(): Promise<StructuredLogger> {
    const instance = new StructuredLogger(await temporaryDirectory('caxri-session-pr-log-'));
    loggers.push(instance);
    return instance;
}

function gitSummary(branch: string, rootPath = '/project'): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo-1',
                kind: 'primary',
                name: 'project',
                rootPath,
                branch,
                head: '1234567',
                ahead: 0,
                behind: 0,
                additions: 0,
                deletions: 0,
                generation: 0,
                changedFileCount: 0,
                truncated: false,
                files: [],
            },
        ],
    };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/project',
        createdAt: 0,
        lastOpenedAt: 0,
        lastSessionActivityAt: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        layoutVersion: 1,
        displayTitle: 'Session',
        titleMode: 'automatic',
        ...overrides,
    } as SessionRecord;
}

function pullRequestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        number: 19024,
        title: 'feat: migrate search',
        url: 'https://github.com/lobehub/lobehub/pull/19024',
        state: 'MERGED',
        isDraft: false,
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        ...overrides,
    });
}

interface Harness {
    emitted: ServerEvent[];
    runner: ReturnType<typeof vi.fn<ProjectStatusRunner>>;
    service: SessionPullRequestService;
    setTranscript: (lines: string[]) => Promise<void>;
}

async function harness(options: {
    branch?: string;
    gh?: (arguments_: readonly string[]) => Promise<string>;
    now?: () => number;
    sessions?: SessionRecord[];
    summary?: (sessionId: string) => Promise<GitSummary>;
}): Promise<Harness> {
    const home = await temporaryDirectory('caxri-session-pr-home-');
    const cwd = '/project';
    const agentSessionId = 'claude-session-1';
    const transcriptPath = claudeTranscriptPath(join(home, '.claude'), cwd, agentSessionId);
    await mkdir(join(transcriptPath, '..'), { recursive: true });
    const terminal = {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'claude',
        provider: 'claude',
        cwd,
        agentSessionId,
    } as unknown as TerminalRecord;
    const sessions = options.sessions ?? [session({ primaryAgentTerminalId: terminal.id })];
    const emitted: ServerEvent[] = [];
    const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
        if (command === 'git') return Promise.resolve('git@github.com:lobehub/lobehub.git\n');
        if (command === 'gh' && options.gh) return options.gh(arguments_);
        return Promise.reject(new ProjectStatusCliError('gh', 'other', 'no pull requests found'));
    });
    const service = new SessionPullRequestService(
        {
            getTerminal: (id) => (id === terminal.id ? terminal : undefined),
            listSessions: () => sessions,
        },
        {
            summary:
                options.summary ?? (() => Promise.resolve(gitSummary(options.branch ?? 'feat/x'))),
        },
        await logger(),
        runner,
        {
            agentEnvironment: { homeDirectory: home, variables: {} },
            emit: (event) => emitted.push(event),
            now: options.now,
        },
    );
    const setTranscript = (lines: string[]): Promise<void> =>
        writeFile(transcriptPath, `${lines.join('\n')}\n`);
    return { emitted, runner, service, setTranscript };
}

const createdPullRequestLines = [
    JSON.stringify({
        type: 'assistant',
        message: {
            content: [
                {
                    type: 'tool_use',
                    id: 'toolu_1',
                    name: 'Bash',
                    input: { command: 'gh pr create' },
                },
            ],
        },
    }),
    JSON.stringify({
        type: 'user',
        message: {
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: 'https://github.com/lobehub/lobehub/pull/19024',
                },
            ],
        },
    }),
];

describe('SessionPullRequestService', () => {
    it('resolves the PR the Agent created from its transcript ahead of the checked-out branch', async () => {
        const gh = vi.fn((arguments_: readonly string[]) => {
            expect(arguments_.slice(0, 5)).toEqual([
                'pr',
                'view',
                '19024',
                '--repo',
                'lobehub/lobehub',
            ]);
            return Promise.resolve(pullRequestJson());
        });
        const { emitted, service, setTranscript } = await harness({ branch: 'main', gh });
        await setTranscript(createdPullRequestLines);

        expect(service.snapshot().pullRequests).toEqual({});
        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toEqual({
            number: 19024,
            title: 'feat: migrate search',
            url: 'https://github.com/lobehub/lobehub/pull/19024',
            state: 'merged',
            checks: 'success',
            source: 'agent',
        });
        expect(emitted).toEqual([
            { event: 'sessionPullRequests.changed', payload: { sessionIds: ['session-1'] } },
        ]);
        expect(gh).toHaveBeenCalledTimes(1);

        await service.refresh();
        expect(gh).toHaveBeenCalledTimes(1);
        expect(emitted).toHaveLength(1);
    });

    it('falls back to the branch lookup and prefers an open PR over a merged one', async () => {
        const gh = vi.fn((arguments_: readonly string[]) => {
            expect(arguments_.slice(0, 5)).toEqual([
                'pr',
                'list',
                '--repo',
                'lobehub/lobehub',
                '--head=feat/x',
            ]);
            return Promise.resolve(
                `[${pullRequestJson({ number: 1, state: 'MERGED' })},${pullRequestJson({
                    number: 2,
                    state: 'OPEN',
                    isDraft: true,
                    statusCheckRollup: [],
                })}]`,
            );
        });
        const { service } = await harness({ gh });
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 2,
            state: 'draft',
            checks: undefined,
            source: 'branch',
        });
    });

    it('never queries an integration branch and skips archived Sessions', async () => {
        const gh = vi.fn(() => Promise.resolve(pullRequestJson()));
        const { runner, service } = await harness({
            branch: 'main',
            gh,
            sessions: [session(), session({ id: 'session-2', archivedAt: 1 })],
        });
        await service.refresh();
        expect(gh).not.toHaveBeenCalled();
        expect(runner.mock.calls.filter(([command]) => command === 'git')).toHaveLength(0);
        expect(service.snapshot().pullRequests).toEqual({});
    });

    it('keeps the last projection across a transient gh failure', async () => {
        let now = 0;
        let shouldFail = false;
        const gh = vi.fn(() =>
            shouldFail
                ? Promise.reject(new ProjectStatusCliError('gh', 'rate-limited', 'rate limited'))
                : Promise.resolve(pullRequestJson({ state: 'OPEN' })),
        );
        const { service, setTranscript } = await harness({ gh, now: () => now });
        await setTranscript(createdPullRequestLines);
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');

        shouldFail = true;
        now += 61_000;
        await service.refresh();
        expect(gh).toHaveBeenCalledTimes(2);
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');
    });

    it('trusts a merely mentioned PR link only for the Session repository', async () => {
        const gh = vi.fn((arguments_: readonly string[]) => {
            if (arguments_[1] === 'view') return Promise.resolve(pullRequestJson({ number: 7 }));
            return Promise.resolve('[]');
        });
        const mention = (url: string): string =>
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: `See ${url}.` }] },
            });
        const { service, setTranscript } = await harness({ gh });
        await setTranscript([mention('https://github.com/stranger/repo/pull/7')]);
        await service.refresh();
        expect(gh.mock.calls.map(([arguments_]) => arguments_[1])).toEqual(['list']);
        expect(service.snapshot().pullRequests['session-1']).toBeUndefined();

        await setTranscript([
            mention('https://github.com/stranger/repo/pull/7'),
            mention('https://github.com/lobehub/lobehub/pull/7'),
        ]);
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 7,
            source: 'agent',
        });
    });

    it('keeps sweeping the other Sessions when one checkout cannot be inspected', async () => {
        const gh = vi.fn(() => Promise.resolve(`[${pullRequestJson({ state: 'OPEN' })}]`));
        const { emitted, service } = await harness({
            gh,
            sessions: [session(), session({ id: 'session-2' })],
            summary: (sessionId) =>
                sessionId === 'session-1'
                    ? Promise.reject(new Error('worktree vanished'))
                    : Promise.resolve(gitSummary('feat/x')),
        });
        await service.refresh();
        const { pullRequests } = service.snapshot();
        expect(Object.keys(pullRequests)).toEqual(['session-2']);
        expect(pullRequests['session-2']).toMatchObject({ number: 19024, state: 'open' });
        expect(emitted).toEqual([
            { event: 'sessionPullRequests.changed', payload: { sessionIds: ['session-2'] } },
        ]);
    });

    it('ranks branch candidates open, then merged, then closed', () => {
        expect(
            selectBranchPullRequest([
                { state: 'CLOSED', number: 1 },
                { state: 'MERGED', number: 2 },
                { state: 'OPEN', number: 3 },
            ])?.number,
        ).toBe(3);
        expect(
            selectBranchPullRequest([
                { state: 'CLOSED', number: 1 },
                { state: 'MERGED', number: 2 },
            ])?.number,
        ).toBe(2);
        expect(selectBranchPullRequest([])).toBeUndefined();
    });
});
