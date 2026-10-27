import type { TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status/index';
import { ExternalStatusCliError } from '../../external-status/index';
import { selectBranchPullRequest } from '../session-pull-request-parse';
import { SessionPullRequestService } from '../session-pull-requests';
import {
    CODEX_THREAD_ID,
    codexCreatedPullRequestLines,
    createdPullRequestLines,
    gitSummary,
    harness,
    pullRequestJson,
    session,
    temporaryDirectory,
    testLogger,
    writeCodexRollout,
} from './session-pull-requests.fixture';

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
                },
            },
        });
        expect(logWrite).toHaveBeenCalledWith('warn', 'session_pull_requests.lookup_unavailable', {
            fields: { reason: 'not-found' },
        });
    });

    /**
     * The sidebar's answer to "did it ship?". Production must be serving this pull request's own merge commit, so the
     * badge describes this Session's delivery rather than the project's general deployment state.
     */
    it('marks a merged pull request deployed when production serves its merge commit', async () => {
        const mergeCommit = '4f0c1d9a7b6e5f4d3c2b1a09876543210fedcba9';
        const { service } = await harness({
            sessions: [session()],
            gh: (arguments_) =>
                arguments_[1] === 'view'
                    ? Promise.resolve(
                          pullRequestJson({ mergeCommit: { oid: mergeCommit }, state: 'MERGED' }),
                      )
                    : Promise.resolve(JSON.stringify([{ number: 19_024, state: 'MERGED' }])),
            vc: (arguments_) =>
                Promise.resolve(
                    arguments_[1] === 'ls'
                        ? JSON.stringify({ teams: [{ slug: 'acme' }] })
                        : JSON.stringify({
                              deployments: [
                                  {
                                      uid: 'dpl_1',
                                      name: 'example',
                                      readyState: 'READY',
                                      url: 'example.vercel.app',
                                      meta: { githubCommitSha: mergeCommit },
                                  },
                              ],
                          }),
                ),
        });
        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            state: 'merged',
            deployment: { state: 'success' },
        });
    });

    it('keeps a merged pull request unmarked while production still serves an older commit', async () => {
        const { service } = await harness({
            sessions: [session()],
            gh: (arguments_) =>
                arguments_[1] === 'view'
                    ? Promise.resolve(
                          pullRequestJson({
                              mergeCommit: { oid: 'b'.repeat(40) },
                              state: 'MERGED',
                          }),
                      )
                    : Promise.resolve(JSON.stringify([{ number: 19_024, state: 'MERGED' }])),
            vc: (arguments_) =>
                Promise.resolve(
                    arguments_[1] === 'ls'
                        ? JSON.stringify({ teams: [{ slug: 'acme' }] })
                        : JSON.stringify({
                              deployments: [
                                  {
                                      uid: 'dpl_1',
                                      name: 'example',
                                      readyState: 'READY',
                                      url: 'example.vercel.app',
                                      meta: { githubCommitSha: 'a'.repeat(40) },
                                  },
                              ],
                          }),
                ),
        });
        await service.refresh();

        const projected = service.snapshot().pullRequests['session-1'];
        expect(projected.state).toBe('merged');
        expect(projected.deployment).toBeUndefined();
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
                              url: `https://github.com/example/example/pull/${number}`,
                          }),
                );
            },
        });
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(42);
        sessions[0] = session({ rootPath: '/other-project', workbenchRootProjectId: 'project-2' });
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
        sessions[0] = session({ rootPath: '/other-project', workbenchRootProjectId: 'project-2' });
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
                              url: `https://github.com/example/example/pull/${number}`,
                          }),
                );
            },
        });
        await service.refresh();
        sessions.push(session({ id: 'session-2' }));
        hasSecond = true;
        const pending = service.refresh();
        await firstCommitted.promise;
        sessions[0] = session({ rootPath: '/other-project', workbenchRootProjectId: 'project-2' });
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
                ? Promise.resolve('git@github.com:example/example.git\n')
                : gh(arguments_),
        );
        const service = new SessionPullRequestService(
            {
                getSession: () => session({ primaryAgentTerminalId: terminal.id }),
                getTerminal: (id) => (id === terminal.id ? terminal : undefined),
                listVisibleSessions: () => [session({ primaryAgentTerminalId: terminal.id })],
            },
            { summary: () => Promise.resolve(gitSummary('main')) },
            await testLogger(),
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
                'example/example',
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
            url: 'https://github.com/example/example/pull/19024',
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
                    'example/example',
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
                'example/example',
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
            // Time never advances, so only the rule change, never a TTL, can invalidate the projection.
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
