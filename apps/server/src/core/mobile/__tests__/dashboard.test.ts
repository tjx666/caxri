import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    buildMobileArchivedSessions,
    buildMobileDashboard,
    MOBILE_DASHBOARD_MAX_BYTES,
} from '../dashboard';

describe('buildMobileDashboard', () => {
    it('projects and bounds Sessions by canonical activity rather than visits', () => {
        const common = {
            projectId: 'project',
            createdAt: 1,
            lastActivityState: 'completed' as const,
            attentionEpoch: 0,
            hasUnread: false,
        };
        const result = buildMobileDashboard({
            hostDisplayName: 'Example Host',
            deviceRole: 'view',
            projects: [{ id: 'project', displayTitle: 'Example Project' }],
            terminals: [],
            sessions: [
                {
                    ...common,
                    id: 'newer-visit',
                    displayTitle: 'Older message',
                    lastOpenedAt: 300,
                    lastSessionActivityAt: 100,
                },
                {
                    ...common,
                    id: 'newer-message',
                    displayTitle: 'Newer message',
                    lastOpenedAt: 10,
                    lastSessionActivityAt: 200,
                },
            ],
        });
        expect(result.sessions.map((session) => session.id)).toEqual([
            'newer-message',
            'newer-visit',
        ]);
        expect(result.sessions[0]).toMatchObject({
            createdAt: 1,
            lastSessionActivityAt: 200,
            lastOpenedAt: 10,
        });
        expect(result.projects[0].lastActivityAt).toBe(200);
    });

    it('prioritizes attention and stays within one encrypted frame for Desktop-scale inputs', () => {
        const longTitle = '🙂'.repeat(1_024);
        const sessions = Array.from({ length: 1_000 }, (_, index) => ({
            id: `session-${index}`,
            projectId: 'project-1',
            displayTitle: longTitle,
            createdAt: index,
            lastSessionActivityAt: index,
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
            resolveAgentEndpoint: (terminalId) =>
                terminalId === 'terminal-0'
                    ? { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 }
                    : undefined,
        });
        expect(result.sessions[0]).toMatchObject({ id: 'session-0', hasUnread: true });
        expect(result.sessions[0]?.primaryAgentEndpoint).toEqual({
            hostId: 'host-1',
            endpointId: 'endpoint-1',
            generation: 1,
        });
        expect(result.projects).toEqual([
            { id: 'project-1', displayTitle: '🙂'.repeat(25), lastActivityAt: 999 },
        ]);
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
                    createdAt: 1,
                    lastSessionActivityAt: 1,
                    lastOpenedAt: 1,
                    lastActivityState: 'completed',
                    attentionEpoch: 0,
                    hasUnread: false,
                },
                {
                    id: 'session-2',
                    projectId: 'project-other',
                    displayTitle: 'Hidden',
                    createdAt: 2,
                    lastSessionActivityAt: 2,
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
            { id: 'project-1', displayTitle: 'Active', lastActivityAt: 1 },
        ]);
        expect(result.sessions.map((session) => session.id)).toEqual(['session-1']);
        expect(result.total).toBe(1);
    });

    it('projects the Shell Terminal for a Session without a primary Agent', () => {
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'view',
            projects: [{ id: 'project-1', displayTitle: 'Project' }],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    displayTitle: 'Shell Session',
                    createdAt: 1,
                    lastSessionActivityAt: 1,
                    lastOpenedAt: 1,
                    lastActivityState: 'idle',
                    attentionEpoch: 0,
                    hasUnread: false,
                },
            ],
            terminals: [
                {
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    kind: 'shell',
                    title: 'Shell',
                    lastProcessState: 'running',
                },
            ],
        });
        expect(result.sessions[0]).toMatchObject({
            id: 'session-1',
            primaryTerminal: { id: 'terminal-1', kind: 'shell' },
        });
        expect(result.sessions[0]?.primaryAgentTerminalId).toBeUndefined();
    });
});

describe('buildMobileArchivedSessions', () => {
    it('lists granted archived Sessions newest first with the primary Agent kind', () => {
        const session = (id: string, projectId: string, archivedAt?: number) => ({
            id,
            projectId,
            displayTitle: id,
            createdAt: 1,
            lastSessionActivityAt: 1,
            lastOpenedAt: 1,
            lastActivityState: 'completed' as const,
            primaryAgentTerminalId: `terminal-${id}`,
            attentionEpoch: 0,
            hasUnread: false,
            ...(archivedAt !== undefined && { archivedAt }),
        });
        const result = buildMobileArchivedSessions({
            projects: [{ id: 'project-1', displayTitle: 'Granted' }],
            sessions: [
                session('active', 'project-1'),
                session('older', 'project-1', 10),
                session('newer', 'project-1', 20),
                session('other-project', 'project-2', 30),
            ],
            terminals: [
                {
                    id: 'terminal-newer',
                    sessionId: 'newer',
                    kind: 'claude' as const,
                    title: 'Claude',
                    lastProcessState: 'stopped' as const,
                },
            ],
        });
        expect(result).toEqual({
            sessions: [
                {
                    id: 'newer',
                    projectId: 'project-1',
                    displayTitle: 'newer',
                    projectTitle: 'Granted',
                    archivedAt: 20,
                    agentKind: 'claude',
                },
                {
                    id: 'older',
                    projectId: 'project-1',
                    displayTitle: 'older',
                    projectTitle: 'Granted',
                    archivedAt: 10,
                },
            ],
            total: 2,
            truncated: false,
        });
    });

    it('bounds the list to one frame', () => {
        const result = buildMobileArchivedSessions({
            projects: [{ id: 'project-1', displayTitle: 'Granted' }],
            sessions: Array.from({ length: 500 }, (_, index) => ({
                id: `session-${index}`,
                projectId: 'project-1',
                displayTitle: '🙂'.repeat(1_024),
                createdAt: 1,
                lastSessionActivityAt: 1,
                lastOpenedAt: 1,
                lastActivityState: 'completed' as const,
                attentionEpoch: 0,
                hasUnread: false,
                archivedAt: index,
            })),
            terminals: [],
        });
        expect(result.truncated).toBe(true);
        expect(result.total).toBe(500);
        expect(result.sessions.length).toBeLessThanOrEqual(64);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(
            MOBILE_DASHBOARD_MAX_BYTES,
        );
    });
});
