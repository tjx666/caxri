import type {
    BotBoard,
    BotBoardRow,
    SessionPullRequest,
    SessionPullRequests,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    botBoardRowsInScope,
    botBoardSections,
    botHandoverDescription,
    botPullRequestBadge,
    botRowPresentation,
    botTaskBadge,
    patchBotBoardPullRequests,
} from '../bot-board';

function row(overrides: Partial<BotBoardRow> = {}): BotBoardRow {
    return {
        activityState: 'idle',
        agent: {
            kind: 'codex',
            processState: 'running',
            terminalId: 'terminal-1',
            title: 'Codex',
        },
        botSession: false,
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

describe('botBoardSections', () => {
    it('orders groups by the protocol, labels them, and drops empty ones', () => {
        const sections = botBoardSections([
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
        const [attention] = botBoardSections([
            row({ group: 'attention', sessionId: 'newer' }),
            row({ group: 'attention', sessionId: 'older' }),
        ]);

        expect(attention.rows.map((entry) => entry.sessionId)).toEqual(['newer', 'older']);
    });

    it('returns no sections for an empty board', () => {
        expect(botBoardSections([])).toEqual([]);
    });
});

describe('botRowPresentation', () => {
    it("draws a live turn in the sidebar's muted running vocabulary and names its Agent", () => {
        const presentation = botRowPresentation(
            row({ activityState: 'running', group: 'working' }),
        );

        expect(presentation).toMatchObject({
            agentLabel: 'Codex',
            glyph: 'spinner',
            statePhrase: 'Working',
            toneClassName: 'text-muted',
        });
    });

    it('describes compaction as its own live state', () => {
        const presentation = botRowPresentation(
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

    it('draws a turn waiting on background work with the quiet running glyph', () => {
        const presentation = botRowPresentation(
            row({
                activityState: 'running',
                agent: {
                    kind: 'claude',
                    operation: 'background',
                    processState: 'running',
                    terminalId: 'terminal-1',
                    title: 'Claude',
                },
                group: 'working',
            }),
        );

        expect(presentation).toMatchObject({
            glyph: 'background',
            statePhrase: 'In background',
            toneClassName: 'text-muted',
        });
    });

    it('tints only rows that ask for the user', () => {
        expect(
            botRowPresentation(
                row({ activityState: 'waiting', group: 'attention', hasUnread: true }),
            ),
        ).toMatchObject({
            glyph: 'question',
            glyphLabel: 'Unread. Waiting for you',
            toneClassName: 'text-warning',
        });
        expect(
            botRowPresentation(row({ activityState: 'failed', group: 'failed' })).toneClassName,
        ).toBe('text-danger');
        expect(
            botRowPresentation(row({ activityState: 'completed', group: 'finished' })),
        ).toMatchObject({ glyph: 'check', statePhrase: 'Finished', toneClassName: 'text-muted' });
    });

    it('lets a stopped process override the last Agent activity', () => {
        const presentation = botRowPresentation(
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
                const presentation = botRowPresentation(
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
                botRowPresentation(
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
            botRowPresentation(row({ activityState: 'running', group: 'working' })).processIcon,
        ).toBeUndefined();
    });

    it('marks a detached Terminal with its own glyph', () => {
        const presentation = botRowPresentation(
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
        expect(botRowPresentation(row({ agent: null }))).toMatchObject({
            agentLabel: 'Shell',
            statePhrase: 'No Terminal',
        });
        expect(
            botRowPresentation(
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

describe('botPullRequestBadge', () => {
    it('has nothing to show without a pull request', () => {
        expect(botPullRequestBadge({})).toBeUndefined();
    });

    it('hides a cached pull request whose last lookup failed', () => {
        expect(
            botPullRequestBadge({
                pullRequest: pullRequest({ checks: 'success' }),
                pullRequestUnavailable: { reason: 'network' },
            }),
        ).toBeUndefined();
    });

    it('shows number, lifecycle, and checks with independent tones', () => {
        expect(botPullRequestBadge({ pullRequest: pullRequest({ checks: 'failure' }) })).toEqual({
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
        const badge = botPullRequestBadge({
            pullRequest: pullRequest({ checks: 'failure', state: 'merged' }),
        });

        expect(badge).toMatchObject({ stateLabel: 'Merged', toneClassName: 'text-merged' });
        expect(badge?.checksLabel).toBeUndefined();
        expect(badge?.checksIcon).toBeUndefined();
        expect(badge?.title).toBe('#42 Merged: Fix the parser');
    });
});

describe('botTaskBadge', () => {
    it('shows nothing for a Session Caxri Bot never delegated into', () => {
        expect(botTaskBadge(undefined)).toBeUndefined();
    });

    it.each([
        ['awaiting_ready', 'Starting', 'text-muted'],
        ['collecting', 'Running', 'text-muted'],
        ['completed', 'Answered', 'text-muted'],
        ['blocked', 'Blocked', 'text-warning'],
        ['answer_unavailable', 'Failed', 'text-danger'],
    ] as const)('labels a %s task as %s', (status, label, toneClassName) => {
        expect(botTaskBadge({ delegationId: 'task-1', status, updatedAt: 1 })).toMatchObject({
            label,
            toneClassName,
        });
    });

    it('names the failure reason in the tooltip without the internal task ID', () => {
        expect(
            botTaskBadge({
                delegationId: 'task-1',
                status: 'failed',
                failure: 'startup_not_ready',
                updatedAt: 1,
            })?.title,
        ).toBe('Failed. The task failed. Reason: startup not ready.');
    });

    it('tints a takeover and explains that Caxri Bot let the Session go', () => {
        const badge = botTaskBadge({
            delegationId: 'task-1',
            status: 'human_intervened',
            failure: 'human_input',
            updatedAt: 1,
        });
        expect(badge).toMatchObject({
            icon: 'taken-over',
            label: 'Taken back by you',
            toneClassName: 'text-warning',
        });
        expect(badge?.title).toContain('no longer drives it');
        expect(badge?.title).not.toContain('Reason');
    });

    it('asks the user to open a Session whose Agent waits at startup', () => {
        expect(
            botTaskBadge({
                delegationId: 'task-1',
                status: 'blocked',
                failure: 'startup_waiting',
                updatedAt: 1,
            }),
        ).toMatchObject({ label: 'Waiting at startup', toneClassName: 'text-warning' });
    });
});

describe('botBoardRowsInScope', () => {
    const own = row({ sessionId: 'own', botSession: true });
    const mine = row({ sessionId: 'mine', botSession: false });
    const later = row({ sessionId: 'later', botSession: true });

    it("lists only Caxri Bot's own Sessions in its scope, in the Server's order", () => {
        expect(botBoardRowsInScope([own, mine, later], 'bot')).toEqual([own, later]);
    });

    it('lists every Session in the whole-Workbench scope', () => {
        expect(botBoardRowsInScope([own, mine, later], 'all')).toEqual([own, mine, later]);
    });
});

describe('patchBotBoardPullRequests', () => {
    function board(rows: BotBoardRow[]): BotBoard {
        return { generatedAt: 1, projects: [], pullRequestsRefreshedAt: 1, rows, tasks: [] };
    }

    function snapshot(overrides: Partial<SessionPullRequests> = {}): SessionPullRequests {
        return { pullRequests: {}, refreshedAt: 2, ...overrides };
    }

    const quiet = row({ sessionId: 'quiet', pullRequest: pullRequest({ number: 7 }) });

    it('adds a newly opened pull request to its row and keeps every other row object', () => {
        const target = row({ sessionId: 'target' });
        const before = board([quiet, target]);

        const after = patchBotBoardPullRequests(
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

        const after = patchBotBoardPullRequests(
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
        const unavailable = { reason: 'not-logged-in' as const };

        const after = patchBotBoardPullRequests(
            board([quiet, target]),
            snapshot({ pullRequests: { target: cached }, unavailable: { target: unavailable } }),
            new Set(['target']),
        );

        expect(after.rows[0]).toBe(quiet);
        expect(after.rows[1]).toEqual({ ...target, pullRequestUnavailable: unavailable });
        expect(botPullRequestBadge(after.rows[1])).toBeUndefined();
    });

    it('drops the pull request and the failure once the snapshot no longer has them', () => {
        const target = row({
            sessionId: 'target',
            pullRequest: pullRequest(),
            pullRequestUnavailable: { reason: 'network' },
        });

        const after = patchBotBoardPullRequests(board([target]), snapshot(), new Set(['target']));

        expect(after.rows[0]).not.toHaveProperty('pullRequest');
        expect(after.rows[0]).not.toHaveProperty('pullRequestUnavailable');
    });

    it('returns the same board when no named row actually changed', () => {
        const before = board([quiet]);
        const unchanged = snapshot({ pullRequests: { quiet: pullRequest({ number: 7 }) } });

        expect(
            patchBotBoardPullRequests(before, unchanged, new Set(['quiet', 'not-on-the-board'])),
        ).toBe(before);
    });
});

describe('botHandoverDescription', () => {
    it('says whether a handed-over Session has a conversation Caxri Bot can continue', () => {
        expect(botHandoverDescription(undefined)).toBeUndefined();
        expect(botHandoverDescription({ handoverId: 'handover-1', state: 'continuable' })).toMatch(
            /continue/i,
        );
        expect(
            botHandoverDescription({
                handoverId: 'handover-1',
                state: 'ownership_only',
                ownershipReason: 'agent_missing',
            }),
        ).not.toBe(botHandoverDescription({ handoverId: 'handover-1', state: 'continuable' }));
    });
});
