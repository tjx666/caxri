import { SESSION_FINISHED_RETENTION_MS } from '@caxri/protocol';
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
    title: 'Mobile phase one',
    projectTitle: 'Caxri',
    lastVisitedAt: 100,
    sessionActivityAt: 100,
    agentActivityState: 'waiting',
    primaryAgentTerminalId: 'terminal-1',
    attentionGeneration: 3,
    hasUnread: true,
    primaryTerminal: terminal,
    ...overrides,
});

describe('mobile session model', () => {
    it('groups like Desktop and orders each group by Session activity', () => {
        const result = buildMobileSessionSections({
            total: 4,
            truncated: false,
            sessions: [
                session(),
                session({
                    id: 'session-2',
                    sessionActivityAt: 200,
                    agentActivityState: 'running',
                    hasUnread: false,
                }),
                session({
                    id: 'session-3',
                    sessionActivityAt: 300,
                    agentActivityState: 'waiting',
                    hasUnread: false,
                }),
                session({
                    id: 'session-4',
                    sessionActivityAt: 400,
                    agentActivityState: 'waiting',
                    hasUnread: false,
                }),
            ],
        });

        expect(result.groups.attention.map((item) => item.id)).toEqual(['session-1']);
        expect(result.groups.working.map((item) => item.id)).toEqual(['session-2']);
        expect(result.groups.waiting.map((item) => item.id)).toEqual(['session-4', 'session-3']);
        expect(result.groups.attention[0]).toMatchObject({
            projectTitle: 'Caxri',
            stateLabel: 'Waiting for you',
        });
    });

    it('files a stale finished Session and a detached one under Idle', () => {
        const result = buildMobileSessionSections(
            {
                total: 3,
                truncated: false,
                sessions: [
                    session({ id: 'fresh', agentActivityState: 'completed', hasUnread: false }),
                    session({
                        id: 'stale',
                        agentActivityState: 'completed',
                        hasUnread: false,
                        sessionActivityAt: 100 - SESSION_FINISHED_RETENTION_MS,
                    }),
                    session({
                        id: 'detached',
                        hasUnread: false,
                        primaryTerminal: { ...terminal, lastProcessState: 'detached' },
                    }),
                ],
            },
            undefined,
            100,
        );

        expect(result.groups.finished.map((item) => item.id)).toEqual(['fresh']);
        expect(result.groups.idle.map((item) => item.id)).toEqual(['detached', 'stale']);
    });

    it('lists a pinned Session only under Pinned, in pinned order, even when it has news', () => {
        const result = buildMobileSessionSections({
            total: 3,
            truncated: false,
            sessions: [
                session({ id: 'pinned-attention', pinnedAt: 2 }),
                session({
                    id: 'pinned-idle',
                    pinnedAt: 1,
                    hasUnread: false,
                    agentActivityState: 'idle',
                }),
                session({ id: 'plain', hasUnread: false, agentActivityState: 'idle' }),
            ],
        });

        expect(result.groups.pinned.map((item) => item.id)).toEqual([
            'pinned-idle',
            'pinned-attention',
        ]);
        expect(result.groups.attention).toEqual([]);
        expect(result.groups.pinned[1].group).toBe('attention');
        expect(result.groups.idle.map((item) => item.id)).toEqual(['plain']);
        expect(result.sessions.map((item) => item.id)).toEqual([
            'pinned-idle',
            'pinned-attention',
            'plain',
        ]);
    });

    it('recognizes a stopped Agent Terminal', () => {
        const item = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [session()],
        }).groups.attention[0];

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
            session({
                id: `session-${index}`,
                sessionActivityAt: index,
                hasUnread: index % 7 === 0,
            }),
        );
        const startedAt = performance.now();

        const result = buildMobileSessionSections({
            total: sessions.length,
            truncated: false,
            sessions,
        });

        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(result.sessions).toHaveLength(1_000);
    });

    it('files a Chat waiting for a usage limit under Idle with the continuation time, even when unread', () => {
        const waiting = session({
            agentActivityState: 'failed',
            hasUnread: true,
            primaryTerminal: { ...terminal, usageLimitWaitAt: Date.UTC(2026, 9, 30, 12, 0) },
        });
        const result = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [waiting],
        });
        expect(result.groups.idle.map((item) => item.id)).toEqual(['session-1']);
        expect(result.groups.failed).toEqual([]);
        expect(result.groups.attention).toEqual([]);
        expect(result.sessions[0].stateLabel).toMatch(/^Continues automatically at /);
        // The wait ends: the unread failure shows again.
        const ended = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [{ ...waiting, primaryTerminal: terminal }],
        });
        expect(ended.groups.attention).toHaveLength(1);
    });
});
