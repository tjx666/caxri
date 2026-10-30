import type { Principal } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { RecordQuerySource } from '../records';
import { RecordQueryService } from '../records';

const source: RecordQuerySource = {
    currentProjectId: () => 'project-2',
    currentSessionId: () => 'session-2',
    projects: () => [
        {
            id: 'project-1',
            title: 'Shared',
            rootPath: '/Users/test/one',
            orderIndex: 0,
            createdAt: 1,
            lastVisitedAt: 1,
        },
        {
            id: 'project-2',
            title: 'Shared',
            rootPath: '/Users/test/two',
            orderIndex: 1,
            createdAt: 2,
            lastVisitedAt: 2,
        },
    ],
    sessions: () => [
        {
            id: 'session-1',
            projectId: 'project-1',
            workbenchRootProjectId: 'project-1',
            rootPath: '/Users/test/one',
            title: 'First',
            createdAt: 1,
            lastVisitedAt: 1,
            sidebarOrder: 0,
            sessionActivityAt: 1,
            sessionActivityReason: 'created',
            agentActivityState: 'unknown',
            attentionGeneration: 0,
            acknowledgedAttentionGeneration: 0,
            hasUnread: false,
            titleMode: 'automatic',
        },
        {
            id: 'session-2',
            projectId: 'project-2',
            workbenchRootProjectId: 'project-2',
            rootPath: '/Users/test/two',
            title: 'Second',
            createdAt: 2,
            lastVisitedAt: 2,
            sidebarOrder: 0,
            sessionActivityAt: 2,
            sessionActivityReason: 'agent_started',
            agentActivityState: 'running',
            attentionGeneration: 1,
            acknowledgedAttentionGeneration: 0,
            hasUnread: true,
            titleMode: 'manual',
        },
    ],
    terminals: () => [
        {
            id: 'terminal-1',
            sessionId: 'session-1',
            kind: 'codex',
            provider: 'codex',
            cwd: '/Users/test/one',
            title: 'Codex',
            ptyTitle: 'dynamic PTY title',
            icon: 'codex',
            orderIndex: 0,
            agentSessionId: 'provider-secret',
            lastProcessState: 'running',
            processId: 123,
            createdAt: 1,
            updatedAt: 1,
        },
        {
            id: 'terminal-2',
            sessionId: 'session-2',
            kind: 'shell',
            cwd: '/Users/test/two',
            title: 'Shell',
            icon: 'shell',
            orderIndex: 0,
            lastProcessState: 'stopped',
            createdAt: 2,
            updatedAt: 2,
        },
    ],
};

const human: Principal = { kind: 'human-cli', id: 'human-1' };
const agent: Principal = {
    kind: 'agent',
    id: 'agent-1',
    endpointId: 'endpoint-1',
    generation: 1,
    projectIds: ['project-1'],
};

describe('Runtime record queries', () => {
    it('resolves human current state without returning raw Home paths', () => {
        const service = new RecordQueryService(source, '/Users/test');

        expect(service.project({ mode: 'current' }, human)).toEqual({
            view: 'human-cli',
            projects: [{ id: 'project-2', title: 'Shared', rootPath: '$HOME/two' }],
        });
        expect(service.session({ mode: 'current' }, human)).toMatchObject({
            view: 'human-cli',
            sessions: [{ id: 'session-2', projectId: 'project-2', title: 'Second' }],
        });
    });

    /**
     * `project list` shows the auto-registered worktree Projects the PrimarySidebar hides, so without this field two
     * rows can carry the same title with nothing to say which is the Project the user added.
     */
    it('marks an auto-registered worktree Project in human output, leaving top-level rows unchanged', () => {
        const service = new RecordQueryService(
            {
                ...source,
                projects: () => [
                    ...source.projects(),
                    {
                        id: 'project-worktree',
                        title: 'Shared',
                        rootPath: '/Users/test/two-worktrees/feature',
                        orderIndex: 2,
                        createdAt: 3,
                        lastVisitedAt: 3,
                        ownerProjectId: 'project-2',
                    },
                ],
            },
            '/Users/test',
        );

        const result = service.project({ mode: 'list' }, human);
        expect(result.projects.at(-1)).toEqual({
            id: 'project-worktree',
            title: 'Shared',
            rootPath: '$HOME/two-worktrees/feature',
            ownerProjectId: 'project-2',
        });
        const topLevel = result.projects.slice(0, -1);
        for (const project of topLevel) expect(project).not.toHaveProperty('ownerProjectId');
    });

    it('lists only top-level Projects to a paired device, even when a worktree Project is granted', () => {
        const service = new RecordQueryService(
            {
                ...source,
                projects: () => [
                    ...source.projects(),
                    {
                        id: 'project-worktree',
                        title: 'feature',
                        rootPath: '/Users/test/two-worktrees/feature',
                        orderIndex: 2,
                        createdAt: 3,
                        lastVisitedAt: 3,
                        ownerProjectId: 'project-2',
                    },
                ],
            },
            '/Users/test',
        );
        const device: Principal = {
            kind: 'paired-device',
            id: 'device-1',
            deviceId: 'device-1',
            role: 'control',
            generation: 1,
            projectIds: ['project-2', 'project-worktree'],
        };

        expect(service.project({ mode: 'list' }, device).projects).toEqual([
            { id: 'project-2', title: 'Shared' },
        ]);
    });

    it('redacts Project roots outside HOME from every human query mode', () => {
        const externalRoot = '/Volumes/Private Client/repository';
        const service = new RecordQueryService(
            {
                ...source,
                currentProjectId: () => 'project-external',
                projects: () => [
                    ...source.projects(),
                    {
                        id: 'project-external',
                        title: 'External Project',
                        rootPath: externalRoot,
                        orderIndex: 2,
                        createdAt: 3,
                        lastVisitedAt: 3,
                    },
                ],
            },
            '/Users/test',
        );

        const results = [
            service.project({ mode: 'list' }, human),
            service.project({ mode: 'show', selector: 'project-external' }, human),
            service.project({ mode: 'current' }, human),
        ];

        for (const result of results) expect(JSON.stringify(result)).not.toContain(externalRoot);
        expect(results[1]).toEqual({
            view: 'human-cli',
            projects: [
                {
                    id: 'project-external',
                    title: 'External Project',
                    rootPath: '$PROJECT/project-external',
                },
            ],
        });
        expect(results[2]).toEqual(results[1]);
    });

    it('filters Agent scope before selector resolution and strips private metadata', () => {
        const service = new RecordQueryService(source, '/Users/test');

        expect(service.project({ mode: 'show', selector: 'project-1' }, agent)).toEqual({
            view: 'agent',
            projects: [{ id: 'project-1', title: 'Shared' }],
        });
        const terminals = service.terminal({ mode: 'list', sessionId: 'session-1' }, agent);
        expect(terminals).toEqual({
            view: 'agent',
            terminals: [
                {
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    kind: 'codex',
                    provider: 'codex',
                    title: 'Codex',
                    lastProcessState: 'running',
                },
            ],
        });
        expect(JSON.stringify(terminals)).not.toContain('provider-secret');
        expect(JSON.stringify(terminals)).not.toContain('dynamic PTY title');
        expect(JSON.stringify(terminals)).not.toContain('/Users/test');
        expect(service.terminal({ mode: 'show', selector: 'Codex' }, agent)).toEqual(terminals);
        expect(() =>
            service.terminal({ mode: 'show', selector: 'dynamic PTY title' }, agent),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
        expect(() => service.terminal({ mode: 'show', selector: 'Shell' }, agent)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }) as Error,
        );
    });

    it('reports when a Chat waiting for a plan limit continues', () => {
        const [stored] = source.terminals();
        const service = new RecordQueryService(
            { ...source, terminals: () => [{ ...stored, usageLimitWaitAt: 123 }] },
            '/Users/test',
        );
        expect(service.terminal({ mode: 'list', sessionId: 'session-1' }, agent).terminals).toEqual(
            [expect.objectContaining({ id: 'terminal-1', usageLimitWaitAt: 123 })],
        );
    });

    it('reports when an Agent only waits on its own background work', () => {
        const [stored] = source.terminals();
        const service = new RecordQueryService(
            { ...source, terminals: () => [{ ...stored, agentOperation: 'background' as const }] },
            '/Users/test',
        );
        expect(service.terminal({ mode: 'list', sessionId: 'session-1' }, agent).terminals).toEqual(
            [expect.objectContaining({ id: 'terminal-1', agentOperation: 'background' })],
        );
    });

    it('lists every top-level Project and its Sessions to an Agent, without paths', () => {
        const service = new RecordQueryService(source, '/Users/test');

        expect(service.project({ mode: 'list' }, agent)).toEqual({
            view: 'agent',
            projects: [
                { id: 'project-1', title: 'Shared' },
                { id: 'project-2', title: 'Shared' },
            ],
        });
        expect(
            service.session({ mode: 'list', projectId: 'project-2' }, agent).sessions,
        ).toMatchObject([{ id: 'session-2', projectId: 'project-2' }]);
        expect(JSON.stringify(service.session({ mode: 'list' }, agent))).not.toContain(
            '/Users/test',
        );
    });

    it('rejects Agent current selectors until an endpoint binds an exact context', () => {
        const service = new RecordQueryService(source, '/Users/test');

        expect(() => service.project({ mode: 'current' }, agent)).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }) as Error,
        );
        expect(() => service.session({ mode: 'current' }, agent)).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }) as Error,
        );
    });
});
