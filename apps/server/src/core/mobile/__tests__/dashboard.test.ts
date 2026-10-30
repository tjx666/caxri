import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    buildMobileArchivedSessions,
    buildMobileDashboard,
    MOBILE_DASHBOARD_MAX_BYTES,
} from '../dashboard';

describe('buildMobileDashboard', () => {
    it('marks each row with its pull request, attention kind, and worktree from data already read', () => {
        const session = (id: string, workbenchRootProjectId: string) => ({
            id,
            projectId: 'project-1',
            workbenchRootProjectId,
            title: id,
            lastVisitedAt: 1,
            sessionActivityAt: 1,
            agentActivityState: 'waiting' as const,
            attentionGeneration: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting' as const,
        });
        const result = buildMobileDashboard({
            hostDisplayName: 'Caxri Host',
            deviceRole: 'view',
            projects: [{ id: 'project-1', title: 'App' }],
            sessions: [session('plain', 'project-1'), session('linked', 'worktree-1')],
            terminals: [],
            pullRequests: {
                linked: {
                    number: 12,
                    title: 'Do not send',
                    url: 'https://github.com/example/app/pull/12',
                    state: 'merged',
                    checks: 'success',
                    source: 'branch',
                },
            },
            worktreeProjects: [{ id: 'worktree-1', title: 'app-feature' }],
        });
        const [linked, plain] = [
            result.sessions.find(({ id }) => id === 'linked'),
            result.sessions.find(({ id }) => id === 'plain'),
        ];
        expect(linked).toMatchObject({
            lastAttentionKind: 'waiting',
            pullRequest: { number: 12, state: 'merged' },
            worktreeTitle: 'app-feature',
        });
        expect(linked?.pullRequest).toEqual({ number: 12, state: 'merged' });
        expect(plain?.pullRequest).toBeUndefined();
        expect(plain?.worktreeTitle).toBeUndefined();
    });

    it('prioritizes attention and stays within one encrypted frame for Desktop-scale inputs', () => {
        const longTitle = '🙂'.repeat(1_024);
        const sessions = Array.from({ length: 1_000 }, (_, index) => ({
            id: `session-${index}`,
            projectId: 'project-1',
            workbenchRootProjectId: 'project-1',
            title: longTitle,
            lastVisitedAt: index,
            sessionActivityAt: index,
            agentActivityState: index === 0 ? ('waiting' as const) : ('completed' as const),
            primaryAgentTerminalId: `terminal-${index}`,
            attentionGeneration: index === 0 ? 1 : 0,
            hasUnread: index === 0,
        }));
        const result = buildMobileDashboard({
            hostDisplayName: 'Caxri Host',
            deviceRole: 'view',
            projects: [{ id: 'project-1', title: longTitle }],
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
            { id: 'project-1', title: '🙂'.repeat(25), lastActivityAt: 999 },
        ]);
        expect(result.truncated).toBe(true);
        expect(result.total).toBe(1_000);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
            MOBILE_DASHBOARD_MAX_BYTES,
        );
    });

    it('orders pinned Sessions first, then the shared status groups, then recency', () => {
        const base = {
            projectId: 'project-1',
            workbenchRootProjectId: 'project-1',
            title: 'Session',
            lastVisitedAt: 1,
            attentionGeneration: 0,
            hasUnread: false,
        };
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            now: 1_000,
            projects: [{ id: 'project-1', title: 'Project' }],
            sessions: [
                { ...base, id: 'idle-new', sessionActivityAt: 900, agentActivityState: 'idle' },
                { ...base, id: 'waiting', sessionActivityAt: 10, agentActivityState: 'waiting' },
                { ...base, id: 'working', sessionActivityAt: 20, agentActivityState: 'running' },
                {
                    ...base,
                    id: 'pinned',
                    sessionActivityAt: 1,
                    agentActivityState: 'idle',
                    pinnedAt: 5,
                },
                {
                    ...base,
                    id: 'unread',
                    sessionActivityAt: 5,
                    agentActivityState: 'completed',
                    hasUnread: true,
                },
            ],
            terminals: [],
        });
        expect(result.sessions.map((session) => session.id)).toEqual([
            'pinned',
            'unread',
            'working',
            'waiting',
            'idle-new',
        ]);
        expect(result.sessions[0]).toMatchObject({ pinnedAt: 5, sessionActivityAt: 1 });
    });

    it('includes empty granted Projects in order and excludes Sessions without a visible Project', () => {
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            projects: [
                { id: 'project-2', title: 'Empty' },
                { id: 'project-1', title: 'Active' },
            ],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                    title: 'Visible',
                    lastVisitedAt: 1,
                    sessionActivityAt: 1,
                    agentActivityState: 'completed',
                    attentionGeneration: 0,
                    hasUnread: false,
                },
                {
                    id: 'session-2',
                    projectId: 'project-other',
                    workbenchRootProjectId: 'project-other',
                    title: 'Hidden',
                    lastVisitedAt: 2,
                    sessionActivityAt: 2,
                    agentActivityState: 'waiting',
                    attentionGeneration: 1,
                    hasUnread: true,
                },
            ],
            terminals: [],
        });
        expect(result.projects).toEqual([
            { id: 'project-2', title: 'Empty' },
            { id: 'project-1', title: 'Active', lastActivityAt: 1 },
        ]);
        expect(result.sessions.map((session) => session.id)).toEqual(['session-1']);
        expect(result.total).toBe(1);
    });

    it('projects the Shell Terminal for a Session without a primary Agent', () => {
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'view',
            projects: [{ id: 'project-1', title: 'Project' }],
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                    title: 'Shell Session',
                    lastVisitedAt: 1,
                    sessionActivityAt: 1,
                    agentActivityState: 'idle',
                    attentionGeneration: 0,
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
            workbenchRootProjectId: projectId,
            title: id,
            lastVisitedAt: 1,
            sessionActivityAt: 1,
            agentActivityState: 'completed' as const,
            primaryAgentTerminalId: `terminal-${id}`,
            attentionGeneration: 0,
            hasUnread: false,
            ...(archivedAt !== undefined && { archivedAt }),
        });
        const result = buildMobileArchivedSessions({
            projects: [{ id: 'project-1', title: 'Granted' }],
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
                    title: 'newer',
                    projectTitle: 'Granted',
                    archivedAt: 20,
                    agentKind: 'claude',
                },
                {
                    id: 'older',
                    projectId: 'project-1',
                    title: 'older',
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
            projects: [{ id: 'project-1', title: 'Granted' }],
            sessions: Array.from({ length: 500 }, (_, index) => ({
                id: `session-${index}`,
                projectId: 'project-1',
                workbenchRootProjectId: 'project-1',
                title: '🙂'.repeat(1_024),
                lastVisitedAt: 1,
                sessionActivityAt: 1,
                agentActivityState: 'completed' as const,
                attentionGeneration: 0,
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

describe('buildMobileDashboard usage-limit waits', () => {
    it('sends when a Chat continues and ranks the waiting Session as idle, not attention or failed', () => {
        const waitingAt = 5_000_000;
        const base = {
            projectId: 'project-1',
            workbenchRootProjectId: 'project-1',
            title: 'Session',
            lastVisitedAt: 1,
            sessionActivityAt: 1,
            attentionGeneration: 0,
        };
        const terminal = (id: string, sessionId: string, usageLimitWaitAt?: number) => ({
            id,
            sessionId,
            kind: 'claude' as const,
            provider: 'claude' as const,
            title: id,
            lastProcessState: 'running' as const,
            ...(usageLimitWaitAt !== undefined && { usageLimitWaitAt }),
        });
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            now: 1_000,
            projects: [{ id: 'project-1', title: 'Granted' }],
            sessions: [
                {
                    ...base,
                    id: 'waiting',
                    agentActivityState: 'failed' as const,
                    hasUnread: true,
                    primaryAgentTerminalId: 'terminal-waiting',
                },
                {
                    ...base,
                    id: 'failed',
                    sessionActivityAt: 2,
                    agentActivityState: 'failed' as const,
                    hasUnread: false,
                    primaryAgentTerminalId: 'terminal-failed',
                },
            ],
            terminals: [
                terminal('terminal-waiting', 'waiting', waitingAt),
                terminal('terminal-failed', 'failed'),
            ],
        });
        expect(result.sessions.map(({ id }) => id)).toEqual(['failed', 'waiting']);
        expect(result.sessions[1]?.primaryTerminal?.usageLimitWaitAt).toBe(waitingAt);
        expect(result.sessions[0]?.primaryTerminal).not.toHaveProperty('usageLimitWaitAt');
    });
});
