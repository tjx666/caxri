import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { buildMobileDashboard, MOBILE_DASHBOARD_MAX_BYTES } from '../dashboard';

describe('buildMobileDashboard', () => {
    it('prioritizes attention and stays within one encrypted frame for Desktop-scale inputs', () => {
        const longTitle = '🙂'.repeat(1_024);
        const sessions = Array.from({ length: 1_000 }, (_, index) => ({
            id: `session-${index}`,
            projectId: 'project-1',
            displayTitle: longTitle,
            lastOpenedAt: index,
            lastActivityState: index === 0 ? ('waiting' as const) : ('completed' as const),
            primaryAgentTerminalId: `terminal-${index}`,
            attentionEpoch: index === 0 ? 1 : 0,
            hasUnread: index === 0,
        }));
        const result = buildMobileDashboard({
            hostDisplayName: 'Caxri Host',
            deviceRole: 'view',
            projects: [{ id: 'project-1', displayTitle: longTitle }],
            sessions,
            terminals: sessions.map((session, index) => ({
                id: `terminal-${index}`,
                sessionId: session.id,
                kind: 'codex' as const,
                provider: 'codex' as const,
                title: longTitle,
                lastProcessState: 'running' as const,
            })),
        });
        expect(result.sessions[0]).toMatchObject({ id: 'session-0', hasUnread: true });
        expect(result.projects).toEqual([{ id: 'project-1', displayTitle: '🙂'.repeat(25) }]);
        expect(result.truncated).toBe(true);
        expect(result.total).toBe(1_000);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
            MOBILE_DASHBOARD_MAX_BYTES,
        );
    });

    it('includes empty granted Projects in order and excludes Sessions without a visible Project', () => {
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            projects: [
                { id: 'project-2', displayTitle: 'Empty' },
                { id: 'project-1', displayTitle: 'Active' },
            ],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    displayTitle: 'Visible',
                    lastOpenedAt: 1,
                    lastActivityState: 'completed',
                    attentionEpoch: 0,
                    hasUnread: false,
                },
                {
                    id: 'session-2',
                    projectId: 'project-other',
                    displayTitle: 'Hidden',
                    lastOpenedAt: 2,
                    lastActivityState: 'waiting',
                    attentionEpoch: 1,
                    hasUnread: true,
                },
            ],
            terminals: [],
        });
        expect(result.projects).toEqual([
            { id: 'project-2', displayTitle: 'Empty' },
            { id: 'project-1', displayTitle: 'Active' },
        ]);
        expect(result.sessions.map((session) => session.id)).toEqual(['session-1']);
        expect(result.total).toBe(1);
    });
});
