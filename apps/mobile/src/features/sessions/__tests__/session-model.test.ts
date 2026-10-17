import { describe, expect, it } from 'vitest';

import type { MobileSession, MobileTerminal } from '../session-model';
import { buildMobileSessionSections, isMobileTerminalStopped } from '../session-model';

const terminal: MobileTerminal = {
    id: 'terminal-1',
    sessionId: 'session-1',
    kind: 'codex',
    provider: 'codex',
    lastProcessState: 'running',
};
const session = (overrides: Partial<MobileSession> = {}): MobileSession => ({
    id: 'session-1',
    projectId: 'project-1',
    displayTitle: 'Mobile phase one',
    projectTitle: 'Caxri',
    lastOpenedAt: 100,
    createdAt: 1,
    lastSessionActivityAt: overrides.lastOpenedAt ?? 100,
    lastActivityState: 'waiting',
    primaryAgentTerminalId: 'terminal-1',
    attentionEpoch: 3,
    hasUnread: true,
    primaryTerminal: terminal,
    ...overrides,
});

describe('mobile session model', () => {
    it('orders Recent by message activity instead of reopening an older Session', () => {
        const newerMessage = {
            ...session({
                id: 'newer-message',
                lastOpenedAt: 10,
                lastActivityState: 'completed',
                hasUnread: false,
            }),
            createdAt: 1,
            lastSessionActivityAt: 200,
        };
        const newerVisit = {
            ...session({
                id: 'newer-visit',
                lastOpenedAt: 300,
                lastActivityState: 'completed',
                hasUnread: false,
            }),
            createdAt: 1,
            lastSessionActivityAt: 100,
        };
        const result = buildMobileSessionSections({
            sessions: [newerVisit, newerMessage],
            total: 2,
            truncated: false,
        });
        expect(result.recent.map((item) => item.id)).toEqual(['newer-message', 'newer-visit']);
    });

    it('groups attention, running, and recent Sessions with stable newest-first order', () => {
        const result = buildMobileSessionSections({
            total: 3,
            truncated: false,
            sessions: [
                session(),
                session({
                    id: 'session-2',
                    lastOpenedAt: 200,
                    lastActivityState: 'running',
                    hasUnread: false,
                }),
                session({
                    id: 'session-3',
                    lastOpenedAt: 300,
                    lastActivityState: 'completed',
                    hasUnread: false,
                }),
            ],
        });

        expect(result.needsAttention.map((item) => item.id)).toEqual(['session-1']);
        expect(result.running.map((item) => item.id)).toEqual(['session-2']);
        expect(result.recent.map((item) => item.id)).toEqual(['session-3']);
        expect(result.needsAttention[0]).toMatchObject({
            projectTitle: 'Caxri',
            stateLabel: 'Waiting for you',
        });
    });

    it('recognizes a stopped Agent Terminal', () => {
        const item = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [session()],
        }).needsAttention[0];

        expect(isMobileTerminalStopped(item)).toBe(false);
        expect(
            isMobileTerminalStopped({
                ...item,
                primaryTerminal: { ...terminal, lastProcessState: 'stopped' },
            }),
        ).toBe(true);
    });

    it('builds one thousand Session rows without a pathological model regression', () => {
        const sessions = Array.from({ length: 1_000 }, (_, index) =>
            session({ id: `session-${index}`, lastOpenedAt: index, hasUnread: index % 7 === 0 }),
        );
        const startedAt = performance.now();

        const result = buildMobileSessionSections({
            total: sessions.length,
            truncated: false,
            sessions,
        });

        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(result.needsAttention).toHaveLength(1_000);
    });
});
