import type {
    CommanderBoard,
    CommanderBoardRow,
    SessionPullRequest,
    SessionPullRequests,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderBoardRowsInScope,
    commanderBoardSections,
    commanderPullRequestBadge,
    commanderRowPresentation,
    commanderTaskBadge,
    patchCommanderBoardPullRequests,
} from '../commander-board';

function row(overrides: Partial<CommanderBoardRow> = {}): CommanderBoardRow {
    return {
        activityState: 'idle',
        agent: {
            kind: 'codex',
            processState: 'running',
            terminalId: 'terminal-1',
            title: 'Codex',
        },
        commanderSession: false,
        group: 'idle',
        hasUnread: false,
        lastActivityAt: 0,
        projectId: 'project-1',
        projectRoot: '/workspace/alpha',
        projectTitle: 'alpha',
        sessionId: 'session-1',
        sessionTitle: 'Fix the parser',
        ...overrides,
    };
}

function pullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
    return {
        number: 42,
        source: 'agent',
        state: 'open',
        title: 'Fix the parser',
        url: 'https://example.com/pull/42',
        ...overrides,
    };
}

describe('commanderBoardSections', () => {
    it('orders groups by the protocol, labels them, and drops empty ones', () => {
        const sections = commanderBoardSections([
            row({ group: 'idle', sessionId: 'idle-1' }),
            row({ group: 'attention', sessionId: 'attention-1' }),
            row({ group: 'finished', sessionId: 'finished-1' }),
            row({ group: 'attention', sessionId: 'attention-2' }),
        ]);

        expect(sections.map((section) => [section.id, section.label])).toEqual([
            ['attention', 'Needs attention'],
            ['finished', 'Recently finished'],
            ['idle', 'Idle'],
        ]);
    });

    it("keeps the Server's order within a group", () => {
        const [attention] = commanderBoardSections([
            row({ group: 'attention', sessionId: 'newer' }),
            row({ group: 'attention', sessionId: 'older' }),
        ]);

        expect(attention.rows.map((entry) => entry.sessionId)).toEqual(['newer', 'older']);
    });

    it('returns no sections for an empty board', () => {
        expect(commanderBoardSections([])).toEqual([]);
    });
});

describe('commanderRowPresentation', () => {
    it('tints a live turn green and names its Agent', () => {
        const presentation = commanderRowPresentation(
            row({ activityState: 'running', group: 'working' }),
        );

        expect(presentation).toMatchObject({
            agentLabel: 'Codex',
            glyph: 'spinner',
            statePhrase: 'Working',
            toneClassName: 'text-success',
        });
    });

    it('describes compaction as its own live state', () => {
        const presentation = commanderRowPresentation(
            row({
                activityState: 'running',
                agent: {
                    kind: 'codex',
                    operation: 'compacting',
                    processState: 'running',
                    terminalId: 'terminal-1',
                    title: 'Codex',
                },
                group: 'working',
            }),
        );

        expect(presentation.statePhrase).toBe('Compacting');
        expect(presentation.glyph).toBe('spinner');
    });

    it('tints only rows that ask for the user', () => {
        expect(
            commanderRowPresentation(
                row({ activityState: 'waiting', group: 'attention', hasUnread: true }),
            ),
        ).toMatchObject({
            glyph: 'question',
            glyphLabel: 'Unread. Waiting for you',
            toneClassName: 'text-warning',
        });
        expect(
            commanderRowPresentation(row({ activityState: 'failed', group: 'failed' }))
                .toneClassName,
        ).toBe('text-danger');
        expect(
            commanderRowPresentation(row({ activityState: 'completed', group: 'finished' })),
        ).toMatchObject({ glyph: 'check', statePhrase: 'Finished', toneClassName: 'text-muted' });
    });

    it('lets a stopped process override the last Agent activity', () => {
        const presentation = commanderRowPresentation(
            row({
                activityState: 'completed',
                agent: {
                    kind: 'claude',
                    processState: 'dead',
                    terminalId: 'terminal-1',
                    title: 'Claude',
                },
                group: 'finished',
            }),
        );

        expect(presentation).toMatchObject({
            agentLabel: 'Claude',
            processIcon: 'exited',
            statePhrase: 'Exited',
        });
    });

    it.each(['dead', 'stopped', 'interrupted'] as const)(
        'never shows a %s Agent as working, whatever its last activity said',
        (processState) => {
            for (const [activityState, operation] of [
                ['running', undefined],
                ['waiting', undefined],
                ['idle', 'compacting'],
            ] as const) {
                const presentation = commanderRowPresentation(
                    row({
                        activityState,
                        agent: {
                            kind: 'codex',
                            operation,
                            processState,
                            terminalId: 'terminal-1',
                            title: 'Codex',
                        },
                    }),
                );

                expect(presentation.glyph).toBe('hollow');
                expect(presentation.toneClassName).toBe('text-muted');
                expect(presentation.glyphLabel).not.toMatch(/working|compacting/i);
            }
        },
    );

    it.each([
        ['suspended', 'suspended', 'Suspended'],
        ['interrupted', 'interrupted', 'Interrupted'],
        ['failed', 'failed', 'Failed to start'],
    ] as const)(
        'draws a %s Agent process as an icon named by its phrase',
        (processState, icon, phrase) => {
            expect(
                commanderRowPresentation(
                    row({
                        agent: {
                            kind: 'codex',
                            processState,
                            terminalId: 'terminal-1',
                            title: 'Codex',
                        },
                    }),
                ),
            ).toMatchObject({ processIcon: icon, statePhrase: phrase });
        },
    );

    it('draws no process icon for a running Agent', () => {
        expect(
            commanderRowPresentation(row({ activityState: 'running', group: 'working' }))
                .processIcon,
        ).toBeUndefined();
    });

    it('marks a detached Terminal with its own glyph', () => {
        const presentation = commanderRowPresentation(
            row({
                agent: {
                    kind: 'codex',
                    processState: 'detached',
                    terminalId: 'terminal-1',
                    title: 'Codex',
                },
            }),
        );

        expect(presentation).toMatchObject({ glyph: 'unplug', statePhrase: 'Detached' });
        // The glyph already shows the detachment, so the metadata line adds no second icon.
        expect(presentation.processIcon).toBeUndefined();
    });

    it('names a Session without a Terminal and a plain shell', () => {
        expect(commanderRowPresentation(row({ agent: null }))).toMatchObject({
            agentLabel: 'Shell',
            statePhrase: 'No Terminal',
        });
        expect(
            commanderRowPresentation(
                row({
                    agent: {
                        kind: 'shell',
                        processState: 'running',
                        terminalId: 'terminal-1',
                        title: 'zsh',
                    },
                }),
            ).agentLabel,
        ).toBe('Shell');
    });
});

describe('commanderPullRequestBadge', () => {
    it('has nothing to show without a pull request', () => {
        expect(commanderPullRequestBadge({})).toBeUndefined();
    });

    it('hides a cached pull request whose last lookup failed', () => {
        expect(
            commanderPullRequestBadge({
                pullRequest: pullRequest({ checks: 'success' }),
                pullRequestUnavailable: { reason: 'network', hint: 'Network unavailable' },
            }),
        ).toBeUndefined();
    });

    it('shows number, lifecycle, and checks with independent tones', () => {
        expect(
            commanderPullRequestBadge({ pullRequest: pullRequest({ checks: 'failure' }) }),
        ).toEqual({
            ariaLabel: 'Pull request #42 open, checks failing. Open in browser.',
            checksIcon: 'failed',
            checksLabel: 'Checks failing',
            checksToneClassName: 'text-danger',
            numberLabel: '#42',
            stateLabel: 'Open',
            title: '#42 Open · Checks failing: Fix the parser',
            toneClassName: 'text-success',
            url: 'https://example.com/pull/42',
        });
    });

    it('omits checks a merged pull request no longer reports', () => {
        const badge = commanderPullRequestBadge({
            pullRequest: pullRequest({ checks: 'failure', state: 'merged' }),
        });

        expect(badge).toMatchObject({ stateLabel: 'Merged', toneClassName: 'text-merged' });
        expect(badge?.checksLabel).toBeUndefined();
        expect(badge?.checksIcon).toBeUndefined();
        expect(badge?.title).toBe('#42 Merged: Fix the parser');
    });
});

describe('commanderTaskBadge', () => {
    it('shows nothing for a Session the Commander never delegated into', () => {
        expect(commanderTaskBadge(undefined)).toBeUndefined();
    });

    it.each([
        ['awaiting_ready', 'Starting', 'text-muted'],
        ['collecting', 'Running', 'text-muted'],
        ['completed', 'Answered', 'text-muted'],
        ['blocked', 'Blocked', 'text-warning'],
        ['answer_unavailable', 'Failed', 'text-danger'],
    ] as const)('labels a %s task as %s', (status, label, toneClassName) => {
        expect(commanderTaskBadge({ delegationId: 'task-1', status, updatedAt: 1 })).toMatchObject({
            label,
            toneClassName,
        });
    });

    it('names the delegation and its failure reason in the tooltip', () => {
        expect(
            commanderTaskBadge({
                delegationId: 'task-1',
                status: 'failed',
                failure: 'startup_not_ready',
                updatedAt: 1,
            })?.title,
        ).toBe('Failed. The task failed. Reason: startup not ready. Task task-1.');
    });

    it('tints a takeover and explains that the Commander let the Session go', () => {
        const badge = commanderTaskBadge({
            delegationId: 'task-1',
            status: 'human_intervened',
            failure: 'human_input',
            updatedAt: 1,
        });
        expect(badge).toMatchObject({
            icon: 'taken-over',
            label: 'Taken over by you',
            toneClassName: 'text-warning',
        });
        expect(badge?.title).toContain('no longer drives it');
        expect(badge?.title).not.toContain('Reason');
    });

    it('asks the user to open a Session whose Agent waits at startup', () => {
        expect(
            commanderTaskBadge({
                delegationId: 'task-1',
                status: 'blocked',
                failure: 'startup_waiting',
                updatedAt: 1,
            }),
        ).toMatchObject({ label: 'Needs you', toneClassName: 'text-warning' });
    });
});

describe('commanderBoardRowsInScope', () => {
    const own = row({ sessionId: 'own', commanderSession: true });
    const mine = row({ sessionId: 'mine', commanderSession: false });
    const later = row({ sessionId: 'later', commanderSession: true });

    it("lists only the Commander's own Sessions in its scope, in the Server's order", () => {
        expect(commanderBoardRowsInScope([own, mine, later], 'commander')).toEqual([own, later]);
    });

    it('lists every Session in the whole-Workbench scope', () => {
        expect(commanderBoardRowsInScope([own, mine, later], 'all')).toEqual([own, mine, later]);
    });
});

describe('patchCommanderBoardPullRequests', () => {
    function board(rows: CommanderBoardRow[]): CommanderBoard {
        return { generatedAt: 1, projects: [], pullRequestsRefreshedAt: 1, rows, tasks: [] };
    }

    function snapshot(overrides: Partial<SessionPullRequests> = {}): SessionPullRequests {
        return { pullRequests: {}, refreshedAt: 2, ...overrides };
    }

    const quiet = row({ sessionId: 'quiet', pullRequest: pullRequest({ number: 7 }) });

    it('adds a newly opened pull request to its row and keeps every other row object', () => {
        const target = row({ sessionId: 'target' });
        const before = board([quiet, target]);

        const after = patchCommanderBoardPullRequests(
            before,
            snapshot({
                pullRequests: {
                    quiet: pullRequest({ number: 7, state: 'merged' }),
                    target: pullRequest({ number: 42 }),
                },
            }),
            new Set(['target']),
        );

        expect(after).not.toBe(before);
        expect(after.rows[0]).toBe(quiet);
        expect(after.rows[1]).not.toBe(target);
        expect(after.rows[1]).toEqual({ ...target, pullRequest: pullRequest({ number: 42 }) });
        expect(after.pullRequestsRefreshedAt).toBe(2);
    });

    it('follows a lifecycle change such as a merge', () => {
        const target = row({
            sessionId: 'target',
            pullRequest: pullRequest({ checks: 'pending' }),
        });
        const merged = pullRequest({ state: 'merged' });

        const after = patchCommanderBoardPullRequests(
            board([target, quiet]),
            snapshot({ pullRequests: { target: merged } }),
            new Set(['target']),
        );

        expect(after.rows[0]?.pullRequest).toEqual(merged);
        expect(after.rows[1]).toBe(quiet);
    });

    it('marks a failed lookup unavailable and keeps the cached pull request beside it', () => {
        const cached = pullRequest();
        const target = row({ sessionId: 'target', pullRequest: cached });
        const unavailable = { hint: 'Run gh auth login.', reason: 'not-logged-in' as const };

        const after = patchCommanderBoardPullRequests(
            board([quiet, target]),
            snapshot({ pullRequests: { target: cached }, unavailable: { target: unavailable } }),
            new Set(['target']),
        );

        expect(after.rows[0]).toBe(quiet);
        expect(after.rows[1]).toEqual({ ...target, pullRequestUnavailable: unavailable });
        expect(commanderPullRequestBadge(after.rows[1])).toBeUndefined();
    });

    it('drops the pull request and the failure once the snapshot no longer has them', () => {
        const target = row({
            sessionId: 'target',
            pullRequest: pullRequest(),
            pullRequestUnavailable: { hint: 'Retry later.', reason: 'network' },
        });

        const after = patchCommanderBoardPullRequests(
            board([target]),
            snapshot(),
            new Set(['target']),
        );

        expect(after.rows[0]).not.toHaveProperty('pullRequest');
        expect(after.rows[0]).not.toHaveProperty('pullRequestUnavailable');
    });

    it('returns the same board when no named row actually changed', () => {
        const before = board([quiet]);
        const unchanged = snapshot({ pullRequests: { quiet: pullRequest({ number: 7 }) } });

        expect(
            patchCommanderBoardPullRequests(
                before,
                unchanged,
                new Set(['quiet', 'not-on-the-board']),
            ),
        ).toBe(before);
    });
});
