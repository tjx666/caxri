import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { decideAgentLifecycleUpdate, DEFAULT_SESSION_TITLE } from '../session-policy';

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'shell',
        provider: undefined,
        cwd: '/repo',
        title: 'Shell',
        orderIndex: 0,
        agentSessionId: undefined,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        projectId: 'project-1',
        workbenchRootProjectId: 'project-1',
        rootPath: '/repo',
        createdAt: 0,
        lastVisitedAt: 0,
        sidebarOrder: 0,
        sessionActivityAt: 0,
        sessionActivityReason: 'created',
        primaryAgentTerminalId: undefined,
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        lastAttentionKind: undefined,
        hasUnread: false,
        title: DEFAULT_SESSION_TITLE,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('decideAgentLifecycleUpdate', () => {
    it('marks a failed Grok turn as failed rather than completed', () => {
        const primary = terminal({ id: 'grok-1', provider: 'grok' });
        expect(
            decideAgentLifecycleUpdate(
                primary,
                session({
                    agentActivityState: 'running',
                    primaryAgentTerminalId: primary.id,
                }),
                'grok',
                'turnFailed',
            ),
        ).toEqual({ agentActivityState: 'failed', attentionKind: 'failed' });
    });
    it('resumes only a primary Agent that was waiting after its tool batch finishes', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });

        expect(
            decideAgentLifecycleUpdate(
                primary,
                session({
                    agentActivityState: 'waiting',
                    primaryAgentTerminalId: primary.id,
                }),
                'claude',
                'toolBatchFinished',
            ),
        ).toEqual({ agentActivityState: 'running' });
        expect(
            decideAgentLifecycleUpdate(
                primary,
                session({
                    agentActivityState: 'running',
                    primaryAgentTerminalId: primary.id,
                }),
                'claude',
                'toolBatchFinished',
            ),
        ).toBeUndefined();
        expect(
            decideAgentLifecycleUpdate(
                primary,
                session({
                    agentActivityState: 'completed',
                    primaryAgentTerminalId: primary.id,
                }),
                'claude',
                'toolBatchFinished',
            ),
        ).toBeUndefined();
    });
    it('supersedes unread attention when a new turn starts, even without a state change', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });
        const unreadCompleted = session({
            attentionGeneration: 1,
            hasUnread: true,
            agentActivityState: 'completed',
            lastAttentionKind: 'completed',
            primaryAgentTerminalId: primary.id,
        });

        expect(
            decideAgentLifecycleUpdate(primary, unreadCompleted, 'claude', 'turnStarted'),
        ).toEqual({ agentActivityState: 'running', supersedesUnreadAttention: true });
        expect(
            decideAgentLifecycleUpdate(
                primary,
                { ...unreadCompleted, agentActivityState: 'running' },
                'claude',
                'turnStarted',
            ),
        ).toEqual({ agentActivityState: 'running', supersedesUnreadAttention: true });
        expect(
            decideAgentLifecycleUpdate(
                primary,
                { ...unreadCompleted, hasUnread: false },
                'claude',
                'turnStarted',
            ),
        ).toEqual({ agentActivityState: 'running' });
    });
    describe('answered attention', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });
        const unread = (
            kind: 'waiting' | 'completed',
            state: 'waiting' | 'completed' | 'running',
        ) =>
            session({
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: state,
                lastAttentionKind: kind,
                primaryAgentTerminalId: primary.id,
            });

        it('supersedes an unread waiting notice and keeps the Session running', () => {
            for (const phase of ['attentionResolved', 'toolBatchFinished'] as const)
                expect(
                    decideAgentLifecycleUpdate(
                        primary,
                        unread('waiting', 'waiting'),
                        'claude',
                        phase,
                    ),
                ).toEqual({ agentActivityState: 'running', supersedesUnreadAttention: true });
        });

        it('supersedes a stale unread waiting notice even when the state already moved on', () => {
            expect(
                decideAgentLifecycleUpdate(
                    primary,
                    unread('waiting', 'running'),
                    'claude',
                    'attentionResolved',
                ),
            ).toEqual({ agentActivityState: 'running', supersedesUnreadAttention: true });
        });

        it('leaves an unread result untouched', () => {
            expect(
                decideAgentLifecycleUpdate(
                    primary,
                    unread('completed', 'completed'),
                    'claude',
                    'attentionResolved',
                ),
            ).toBeUndefined();
        });

        it('raises the result notice when the turn finishes after the answer', () => {
            const answered = session({
                attentionGeneration: 1,
                acknowledgedAttentionGeneration: 1,
                hasUnread: false,
                agentActivityState: 'running',
                lastAttentionKind: 'waiting',
                primaryAgentTerminalId: primary.id,
            });
            expect(decideAgentLifecycleUpdate(primary, answered, 'claude', 'turnFinished')).toEqual(
                { agentActivityState: 'completed', attentionKind: 'completed' },
            );
        });
    });
});
