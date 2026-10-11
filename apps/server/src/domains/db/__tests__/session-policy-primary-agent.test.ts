import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { chooseLivePrimaryAgentSuccessor, DEFAULT_SESSION_TITLE } from '../session-policy';

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'shell',
        provider: undefined,
        cwd: '/repo',
        title: 'Shell',
        icon: 'shell',
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
        workbenchProjectId: 'project-1',
        rootPath: '/repo',
        createdAt: 0,
        lastOpenedAt: 0,
        sidebarOrder: 0,
        lastSessionActivityAt: 0,
        lastSessionActivityReason: 'created',
        primaryAgentTerminalId: undefined,
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        lastAttentionKind: undefined,
        hasUnread: false,
        displayTitle: DEFAULT_SESSION_TITLE,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('chooseLivePrimaryAgentSuccessor', () => {
    it.each(['starting', 'running'] as const)(
        'promotes a %s secondary Agent after the primary exits',
        (lastAgentProcessState) => {
            const primary = terminal({
                id: 'codex-1',
                provider: 'codex',
                lastAgentProcessState: 'stopped',
            });
            const secondary = terminal({
                id: 'codex-2',
                provider: 'codex',
                lastAgentProcessState,
            });

            expect(
                chooseLivePrimaryAgentSuccessor(
                    [primary, secondary],
                    session({ primaryAgentTerminalId: primary.id, displayTitle: 'Existing' }),
                    primary.id,
                ),
            ).toEqual({
                primaryAgentTerminalId: secondary.id,
                displayTitle: 'Existing',
                lastActivityState: 'unknown',
            });
        },
    );

    it('keeps the resumable primary when no secondary Agent is live', () => {
        const primary = terminal({
            id: 'codex-1',
            provider: 'codex',
            lastAgentProcessState: 'stopped',
        });
        const secondary = terminal({
            id: 'codex-2',
            provider: 'codex',
            lastAgentProcessState: 'dead',
        });

        expect(
            chooseLivePrimaryAgentSuccessor(
                [primary, secondary],
                session({ primaryAgentTerminalId: primary.id }),
                primary.id,
            ),
        ).toBeUndefined();
    });

    it('does not replace a different primary when a secondary Agent exits', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const secondary = terminal({
            id: 'codex-2',
            provider: 'codex',
            lastAgentProcessState: 'stopped',
        });

        expect(
            chooseLivePrimaryAgentSuccessor(
                [primary, secondary],
                session({ primaryAgentTerminalId: primary.id }),
                secondary.id,
            ),
        ).toBeUndefined();
    });
});
