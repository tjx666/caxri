import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../shared/ipc/principal';
import { RecordQueryService, type RecordQuerySource } from '../records';

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
            rootPath: '/Users/test/one',
            displayTitle: 'First',
            createdAt: 1,
            lastOpenedAt: 1,
            lastActivityState: 'unknown',
            attentionEpoch: 0,
            readAttentionEpoch: 0,
            hasUnread: false,
            layoutVersion: 1,
            titleMode: 'automatic',
        },
        {
            id: 'session-2',
            projectId: 'project-2',
            rootPath: '/Users/test/two',
            displayTitle: 'Second',
            createdAt: 2,
            lastOpenedAt: 2,
            lastActivityState: 'running',
            attentionEpoch: 1,
            readAttentionEpoch: 0,
            hasUnread: true,
            layoutVersion: 1,
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
            icon: 'codex',
            orderIndex: 0,
            layoutNodeId: 'layout-1',
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
            layoutNodeId: 'layout-2',
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
        expect(JSON.stringify(terminals)).not.toContain('/Users/test');
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
