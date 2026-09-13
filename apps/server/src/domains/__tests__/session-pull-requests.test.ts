import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AppSettings,
    GitSummary,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeTranscriptPath } from '../agents/providers/claude/paths';
import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
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
        sidebarOrder: 0,
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
    };
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
    logger: StructuredLogger;
    runner: ReturnType<typeof vi.fn<ExternalStatusRunner>>;
    service: SessionPullRequestService;
    setTranscript: (lines: string[]) => Promise<void>;
    terminal: TerminalRecord;
}

async function harness(options: {
    branch?: string;
    gh?: (arguments_: readonly string[]) => Promise<string>;
    now?: () => number;
    sessions?: SessionRecord[];
    settings?: () => AppSettings;
    summary?: (sessionId: string) => Promise<GitSummary>;
    onSessionRead?: (sessionId: string) => void;
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
    const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git') return Promise.resolve('git@github.com:lobehub/lobehub.git\n');
        if (command === 'gh' && options.gh) return options.gh(arguments_);
        return Promise.reject(new ExternalStatusCliError('gh', 'other', 'no pull requests found'));
    });
    const structuredLogger = await logger();
    const service = new SessionPullRequestService(
        {
            getSession: (id) => {
                options.onSessionRead?.(id);
                return sessions.find((candidate) => candidate.id === id);
            },
            getTerminal: (id) => (id === terminal.id ? terminal : undefined),
            listSessions: () => sessions,
        },
        {
            summary:
                options.summary ?? (() => Promise.resolve(gitSummary(options.branch ?? 'feat/x'))),
        },
        structuredLogger,
        runner,
        {
            agentEnvironment: { homeDirectory: home, variables: {} },
            emit: (event) => emitted.push(event),
            now: options.now,
            settings: options.settings,
        },
    );
    const setTranscript = (lines: string[]): Promise<void> =>
        writeFile(transcriptPath, `${lines.join('\n')}\n`);
    return { emitted, logger: structuredLogger, runner, service, setTranscript, terminal };
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

/**
 * UUIDv7 Codex thread id; its leading 48 bits place the rollout in the local day folder of 2026-05-27.
 */
const CODEX_THREAD_ID = '019e676d-8740-7bb2-8bcb-f189c8260607';

async function writeCodexRollout(home: string, lines: string[]): Promise<void> {
    const day = new Date(0x019e676d8740);
    const segments = [
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
    ];
    const directory = join(home, '.codex', 'sessions', ...segments);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, `rollout-${segments.join('-')}T11-14-52-${CODEX_THREAD_ID}.jsonl`),
        `${lines.join('\n')}\n`,
    );
}

const codexCreatedPullRequestLines = [
    JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'gh pr create --fill', workdir: '/project' }),
            call_id: 'call_1',
        },
    }),
    JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Output:\nhttps://github.com/lobehub/lobehub/pull/19024\n',
        },
    }),
];

describe('SessionPullRequestService', () => {
    it('reports a failed branch lookup instead of silently omitting the pull request', async () => {
        const { logger: structuredLogger, service } = await harness({
            sessions: [session()],
            gh: () => Promise.reject(new ExternalStatusCliError('gh', 'not-found', 'missing')),
        });
        const logWrite = vi.spyOn(structuredLogger, 'write');
        await service.refresh();

        expect(service.snapshot()).toMatchObject({
            unavailable: {
                'session-1': {
                    reason: 'not-found',
                    hint: 'GitHub CLI is not installed. Install gh, then refresh.',
                },
            },
        });
        expect(logWrite).toHaveBeenCalledWith('warn', 'session_pull_requests.lookup_unavailable', {
            fields: { reason: 'not-found' },
        });
    });

    it('keeps a confirmed missing pull request distinct from CLI failure', async () => {
        const { service } = await harness({
            sessions: [session()],
            gh: () => Promise.resolve('[]'),
        });
        await service.refresh();
        expect(service.snapshot()).toMatchObject({ pullRequests: {} });
        expect(service.snapshot().unavailable).toBeUndefined();
    });

    it('clears the unknown state after GitHub CLI recovers', async () => {
        let now = 0;
        let isUnavailable = true;
        const { service } = await harness({
            sessions: [session()],
            now: () => now,
            gh: (arguments_) =>
                isUnavailable
                    ? Promise.reject(new ExternalStatusCliError('gh', 'not-logged-in', 'login'))
                    : Promise.resolve(
                          arguments_[1] === 'list'
                              ? JSON.stringify([{ number: 42, state: 'OPEN' }])
                              : pullRequestJson({ number: 42, state: 'OPEN' }),
                      ),
        });
        await service.refresh();
        expect(service.snapshot().unavailable?.['session-1']?.reason).toBe('not-logged-in');

        isUnavailable = false;
        now += 61_000;
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(42);
        expect(service.snapshot().unavailable).toBeUndefined();
    });

    it('refreshes a branch projection immediately when the Workbench Root changes', async () => {
        const sessions = [session()];
        const { service } = await harness({
            sessions,
            now: () => 0,
            summary: () =>
                Promise.resolve(
                    gitSummary(sessions[0].rootPath === '/project' ? 'feat/a' : 'feat/b'),
                ),
            gh: (arguments_) => {
                const number =
                    arguments_.includes('--head=feat/a') || arguments_.includes('42') ? 42 : 43;
                return Promise.resolve(
                    arguments_[1] === 'list'
                        ? JSON.stringify([{ number, state: 'OPEN' }])
                        : pullRequestJson({
                              number,
                              state: 'OPEN',
                              url: `https://github.com/lobehub/lobehub/pull/${number}`,
                          }),
                );
            },
        });
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(42);
        sessions[0] = session({ rootPath: '/other-project', workbenchProjectId: 'project-2' });
        expect(service.snapshot().pullRequests['session-1']).toBeUndefined();
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(43);
    });

    it('discards an in-flight lookup when its Workbench Root changes', async () => {
        const sessions = [session()];
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const { service } = await harness({
            sessions,
            now: () => 0,
            summary: () =>
                Promise.resolve(
                    gitSummary(sessions[0].rootPath === '/project' ? 'feat/a' : 'main'),
                ),
            gh: async (arguments_) => {
                if (arguments_[1] === 'list') {
                    started.resolve();
                    await release.promise;
                    return JSON.stringify([{ number: 42, state: 'OPEN' }]);
                }
                return pullRequestJson({ number: 42, state: 'OPEN' });
            },
        });
        const refresh = service.refresh();
        await started.promise;
        sessions[0] = session({ rootPath: '/other-project', workbenchProjectId: 'project-2' });
        release.resolve();
        await refresh;
        expect(service.snapshot().pullRequests).toEqual({});
    });

    it('discovers the primary Agent PR without waiting for the previous branch cache to expire', async () => {
        const sessions = [session()];
        const { service, setTranscript } = await harness({
            sessions,
            now: () => 0,
            branch: 'main',
            gh: () => Promise.resolve(pullRequestJson()),
        });
        await service.refresh();
        expect(service.snapshot().pullRequests).toEqual({});
        await setTranscript(createdPullRequestLines);
        sessions[0] = session({ primaryAgentTerminalId: 'terminal-1' });
        service.snapshot();
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.source).toBe('agent');
    });

    it('refreshes a changed Session that already settled while another Session is still pending', async () => {
        const sessions = [session()];
        const firstCommitted = Promise.withResolvers<void>();
        const releaseSecond = Promise.withResolvers<void>();
        let hasSecond = false;
        const { service } = await harness({
            sessions,
            now: () => 0,
            onSessionRead: (id) => {
                if (hasSecond && id === 'session-1') firstCommitted.resolve();
            },
            summary: async (id) => {
                if (id === 'session-2') {
                    await releaseSecond.promise;
                    return gitSummary('main');
                }
                return gitSummary(sessions[0].rootPath === '/project' ? 'feat/a' : 'feat/b');
            },
            gh: (arguments_) => {
                const number =
                    arguments_.includes('--head=feat/a') || arguments_.includes('42') ? 42 : 43;
                return Promise.resolve(
                    arguments_[1] === 'list'
                        ? JSON.stringify([{ number, state: 'OPEN' }])
                        : pullRequestJson({
                              number,
                              state: 'OPEN',
                              url: `https://github.com/lobehub/lobehub/pull/${number}`,
                          }),
                );
            },
        });
        await service.refresh();
        sessions.push(session({ id: 'session-2' }));
        hasSecond = true;
        const pending = service.refresh();
        await firstCommitted.promise;
        sessions[0] = session({ rootPath: '/other-project', workbenchProjectId: 'project-2' });
        expect(service.snapshot().pullRequests['session-1']).toBeUndefined();
        releaseSecond.resolve();
        await pending;
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(43);
    });

    it.each(['agentSessionId', 'agentCwd'] as const)(
        'discards an in-flight Agent projection when the same terminal changes %s',
        async (field) => {
            const started = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const { service, setTranscript, terminal } = await harness({
                now: () => 0,
                branch: 'main',
                gh: async () => {
                    started.resolve();
                    await release.promise;
                    return pullRequestJson();
                },
            });
            await setTranscript(createdPullRequestLines);
            const pending = service.refresh();
            await started.promise;
            terminal[field] =
                field === 'agentSessionId' ? 'replacement-session' : '/replacement-cwd';
            release.resolve();
            await pending;
            expect(service.snapshot().pullRequests).toEqual({});
        },
    );

    it('resolves the PR a Codex Agent created from its rollout while the Session sits on main', async () => {
        const home = await temporaryDirectory('caxri-session-pr-codex-home-');
        await writeCodexRollout(home, codexCreatedPullRequestLines);
        const terminal = {
            id: 'terminal-codex',
            sessionId: 'session-1',
            kind: 'codex',
            provider: 'codex',
            cwd: '/project',
            agentSessionId: CODEX_THREAD_ID,
        } as unknown as TerminalRecord;
        const gh = vi.fn((arguments_: readonly string[]) => {
            expect(arguments_.slice(0, 3)).toEqual(['pr', 'view', '19024']);
            return Promise.resolve(pullRequestJson());
        });
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) =>
            command === 'git'
                ? Promise.resolve('git@github.com:lobehub/lobehub.git\n')
                : gh(arguments_),
        );
        const service = new SessionPullRequestService(
            {
                getSession: () => session({ primaryAgentTerminalId: terminal.id }),
                getTerminal: (id) => (id === terminal.id ? terminal : undefined),
                listSessions: () => [session({ primaryAgentTerminalId: terminal.id })],
            },
            { summary: () => Promise.resolve(gitSummary('main')) },
            await logger(),
            runner,
            { agentEnvironment: { homeDirectory: home, variables: {} }, emit: () => {} },
        );

        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 19024,
            state: 'merged',
            source: 'agent',
        });
        expect(gh).toHaveBeenCalledTimes(1);
    });

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
            if (arguments_[1] === 'list') {
                expect(arguments_.slice(0, 5)).toEqual([
                    'pr',
                    'list',
                    '--repo',
                    'lobehub/lobehub',
                    '--head=feat/x',
                ]);
                /**
                 * Discovery only has to rank candidates, so it must never pay for `statusCheckRollup` across a page of
                 * pull requests. The selected one's checks come from the shared record below.
                 */
                expect(arguments_.at(-1)).toBe('number,state,isDraft');
                return Promise.resolve(
                    `[${pullRequestJson({ number: 1, state: 'MERGED' })},${pullRequestJson({
                        number: 2,
                        state: 'OPEN',
                        isDraft: true,
                    })}]`,
                );
            }
            expect(arguments_.slice(0, 5)).toEqual([
                'pr',
                'view',
                '2',
                '--repo',
                'lobehub/lobehub',
            ]);
            return Promise.resolve(
                pullRequestJson({
                    number: 2,
                    state: 'OPEN',
                    isDraft: true,
                    statusCheckRollup: [],
                }),
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

    it('leaves an ignored check out of the sidebar badge, matching the Status panel rollup', async () => {
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? `[${pullRequestJson({ number: 19024, state: 'OPEN' })}]`
                    : pullRequestJson({
                          state: 'OPEN',
                          statusCheckRollup: [
                              { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
                              { name: 'flaky', status: 'COMPLETED', conclusion: 'FAILURE' },
                          ],
                      }),
            ),
        );
        const settings = (ignoredChecks: string[]) => () => ({
            ...defaultAppSettings,
            'projectStatus.ignoredChecks': ignoredChecks,
        });

        const reported = await harness({ gh, settings: settings([]) });
        await reported.service.refresh();
        expect(reported.service.snapshot().pullRequests['session-1']?.checks).toBe('failure');

        const ignored = await harness({ gh, settings: settings(['flaky']) });
        await ignored.service.refresh();
        expect(ignored.service.snapshot().pullRequests['session-1']?.checks).toBe('success');
    });

    it('re-sweeps the badge when the ignored checks change, instead of waiting out the TTL', async () => {
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? `[${pullRequestJson({ number: 19024, state: 'OPEN' })}]`
                    : pullRequestJson({
                          state: 'OPEN',
                          statusCheckRollup: [
                              { name: 'flaky', status: 'COMPLETED', conclusion: 'FAILURE' },
                          ],
                      }),
            ),
        );
        let ignoredChecks: string[] = [];
        const { service } = await harness({
            gh,
            // Time never advances, so only the rule change — never a TTL — can invalidate the projection.
            now: () => 0,
            settings: () => ({
                ...defaultAppSettings,
                'projectStatus.ignoredChecks': ignoredChecks,
            }),
        });
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.checks).toBe('failure');

        ignoredChecks = ['flaky'];
        // `snapshot` notices the superseded rules and expires the projection, which starts the re-sweep it awaits.
        service.snapshot();
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.checks).toBeUndefined();
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
                ? Promise.reject(new ExternalStatusCliError('gh', 'rate-limited', 'rate limited'))
                : Promise.resolve(pullRequestJson({ state: 'OPEN' })),
        );
        const { service, setTranscript } = await harness({ gh, now: () => now });
        await setTranscript(createdPullRequestLines);
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');

        shouldFail = true;
        // Past both this service's own TTL and the shared record's, so the sweep really does re-spawn `gh` and hit
        // the failure rather than being served a still-fresh projection.
        now += 91_000;
        await service.refresh();
        expect(gh).toHaveBeenCalledTimes(2);
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');
        expect(service.snapshot().unavailable?.['session-1']).toMatchObject({
            reason: 'rate-limited',
        });
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
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? `[${pullRequestJson({ state: 'OPEN' })}]`
                    : pullRequestJson({ state: 'OPEN' }),
            ),
        );
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
