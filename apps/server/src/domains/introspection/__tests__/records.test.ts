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
            displayTitle: 'Shared',
            rootPath: '/Users/test/one',
            orderIndex: 0,
            createdAt: 1,
            lastOpenedAt: 1,
        },
        {
            id: 'project-2',
            displayTitle: 'Shared',
            rootPath: '/Users/test/two',
            orderIndex: 1,
            createdAt: 2,
            lastOpenedAt: 2,
        },
    ],
    sessions: () => [
        {
            id: 'session-1',
            projectId: 'project-1',
            workbenchProjectId: 'project-1',
            rootPath: '/Users/test/one',
            displayTitle: 'First',
            createdAt: 1,
            lastOpenedAt: 1,
            sidebarOrder: 0,
            lastSessionActivityAt: 1,
            lastSessionActivityReason: 'created',
            lastActivityState: 'unknown',
            attentionEpoch: 0,
            readAttentionEpoch: 0,
            hasUnread: false,
            titleMode: 'automatic',
        },
        {
            id: 'session-2',
            projectId: 'project-2',
            workbenchProjectId: 'project-2',
            rootPath: '/Users/test/two',
            displayTitle: 'Second',
            createdAt: 2,
            lastOpenedAt: 2,
            sidebarOrder: 0,
            lastSessionActivityAt: 2,
            lastSessionActivityReason: 'agent_started',
            lastActivityState: 'running',
            attentionEpoch: 1,
            readAttentionEpoch: 0,
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
            projects: [{ id: 'project-2', displayTitle: 'Shared', rootPath: '$HOME/two' }],
        });
        expect(service.session({ mode: 'current' }, human)).toMatchObject({
            view: 'human-cli',
            sessions: [{ id: 'session-2', projectId: 'project-2', displayTitle: 'Second' }],
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
                        displayTitle: 'Shared',
                        rootPath: '/Users/test/two-worktrees/feature',
                        orderIndex: 2,
                        createdAt: 3,
                        lastOpenedAt: 3,
                        ownerProjectId: 'project-2',
                    },
                ],
            },
            '/Users/test',
        );

        const result = service.project({ mode: 'list' }, human);
        expect(result.projects.at(-1)).toEqual({
            id: 'project-worktree',
            displayTitle: 'Shared',
            rootPath: '$HOME/two-worktrees/feature',
            ownerProjectId: 'project-2',
        });
        const topLevel = result.projects.slice(0, -1);
        for (const project of topLevel) expect(project).not.toHaveProperty('ownerProjectId');
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
                        displayTitle: 'External Project',
                        rootPath: externalRoot,
                        orderIndex: 2,
                        createdAt: 3,
                        lastOpenedAt: 3,
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
                    displayTitle: 'External Project',
                    rootPath: '$PROJECT/project-external',
                },
            ],
        });
        expect(results[2]).toEqual(results[1]);
    });

    it('filters Agent scope before selector resolution and strips private metadata', () => {
        const service = new RecordQueryService(source, '/Users/test');

        expect(service.project({ mode: 'show', selector: 'Shared' }, agent)).toEqual({
            view: 'agent',
            projects: [{ id: 'project-1', displayTitle: 'Shared' }],
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
        expect(() => service.session({ mode: 'show', selector: 'session-2' }, agent)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }) as Error,
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
