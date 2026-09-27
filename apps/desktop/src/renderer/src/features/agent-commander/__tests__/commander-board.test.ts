import type { CommanderBoardRow, SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderBoardSections,
    commanderPullRequestBadge,
    commanderRowPresentation,
    commanderTaskBadge,
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
                    title: 'Claude Code',
                },
                group: 'finished',
            }),
        );

        expect(presentation).toMatchObject({ agentLabel: 'Claude Code', statePhrase: 'Exited' });
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
        expect(commanderPullRequestBadge(undefined)).toBeUndefined();
    });

    it('shows number, lifecycle, and checks with independent tones', () => {
        expect(commanderPullRequestBadge(pullRequest({ checks: 'failure' }))).toEqual({
            ariaLabel: 'Pull request #42 open, checks failing. Open in browser.',
            checksLabel: 'Checks failing',
            checksToneClassName: 'text-danger',
            numberLabel: '#42',
            stateLabel: 'Open',
            title: 'Fix the parser',
            toneClassName: 'text-success',
            url: 'https://example.com/pull/42',
        });
    });

    it('omits checks a merged pull request no longer reports', () => {
        const badge = commanderPullRequestBadge(
            pullRequest({ checks: 'failure', state: 'merged' }),
        );

        expect(badge).toMatchObject({ stateLabel: 'Merged', toneClassName: 'text-merged' });
        expect(badge?.checksLabel).toBeUndefined();
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
        ).toBe('Commander task task-1: Failed (startup not ready)');
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
