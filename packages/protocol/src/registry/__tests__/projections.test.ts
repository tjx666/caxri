import { describe, expect, it } from 'vitest';

import { agentProviderIds } from '../../agent/agents';
import type { Principal } from '../../transport/principal';
import { principalProjectionSchemas, projectListForPrincipal } from '../projections';

const projects = [
    {
        id: 'project-1',
        rootPath: '/private/project-one',
        title: 'Project One',
        orderIndex: 0,
        createdAt: 1,
        lastVisitedAt: 1,
    },
    {
        id: 'project-2',
        rootPath: '/private/project-two',
        title: 'Project Two',
        orderIndex: 1,
        createdAt: 2,
        lastVisitedAt: 2,
    },
];

const value = { view: 'desktop', projects } as const;

describe('projectListForPrincipal', () => {
    it('keeps an external delegation identity restricted to its one Project without root paths', () => {
        expect(
            projectListForPrincipal(value, {
                kind: 'delegation-client',
                id: 'delegation-client:client',
                clientId: 'client',
                generation: 1,
                projectIds: ['project-2'],
                sessionId: 'session',
                callerProvider: 'codex',
            }),
        ).toEqual({
            view: 'delegation-client',
            projects: [{ id: 'project-2', title: 'Project Two' }],
        });
    });
    it('returns the full record for a desktop principal', () => {
        const desktop: Principal = { kind: 'desktop', id: 'desktop-1', generation: 1 };
        expect(projectListForPrincipal(value, desktop)).toEqual({ view: 'desktop', projects });
    });

    it('drops orderIndex/createdAt/lastVisitedAt for a human CLI principal', () => {
        const human: Principal = { kind: 'human-cli', id: 'cli-1' };
        const result = projectListForPrincipal(value, human);
        expect(result).toEqual({
            view: 'human-cli',
            projects: [
                { id: 'project-1', title: 'Project One', rootPath: '/private/project-one' },
                { id: 'project-2', title: 'Project Two', rootPath: '/private/project-two' },
            ],
        });
    });

    /**
     * The CLI, unlike the PrimarySidebar, lists worktree Projects next to the ones the user added, so it is the one
     * surface that needs `ownerProjectId` to tell two same-titled rows apart. A top-level Project omits the key rather
     * than carrying a null, so ordinary output stays as it was.
     */
    it('carries ownerProjectId for a human CLI principal, and only on a worktree Project', () => {
        const human: Principal = { kind: 'human-cli', id: 'cli-1' };
        const result = projectListForPrincipal(
            {
                view: 'desktop',
                projects: [projects[0], { ...projects[1], ownerProjectId: 'project-1' }],
            },
            human,
        );
        expect(result.projects).toEqual([
            { id: 'project-1', title: 'Project One', rootPath: '/private/project-one' },
            {
                id: 'project-2',
                title: 'Project Two',
                rootPath: '/private/project-two',
                ownerProjectId: 'project-1',
            },
        ]);
    });

    it('scopes an agent principal to only its authorized project IDs, dropping rootPath', () => {
        const agent: Principal = {
            kind: 'agent',
            id: 'agent-1',
            endpointId: 'endpoint-1',
            generation: 1,
            projectIds: ['project-2'],
        };
        const result = projectListForPrincipal(value, agent);
        expect(result).toEqual({
            view: 'agent',
            projects: [{ id: 'project-2', title: 'Project Two' }],
        });
    });

    it('scopes a paired-device principal the same way as an agent principal', () => {
        const pairedDevice: Principal = {
            kind: 'paired-device',
            id: 'device-1',
            deviceId: 'device-1',
            role: 'control',
            generation: 1,
            projectIds: ['project-1', 'project-2'],
        };
        const result = projectListForPrincipal(value, pairedDevice);
        expect(result).toEqual({
            view: 'paired-device',
            projects: [
                { id: 'project-1', title: 'Project One' },
                { id: 'project-2', title: 'Project Two' },
            ],
        });
    });

    it('returns an empty list for a scoped principal authorized for no listed project', () => {
        const agent: Principal = {
            kind: 'agent',
            id: 'agent-1',
            endpointId: 'endpoint-1',
            generation: 1,
            projectIds: [],
        };
        expect(projectListForPrincipal(value, agent)).toEqual({ view: 'agent', projects: [] });
    });

    it('rejects a malformed source value before it reaches any principal projection', () => {
        expect(() =>
            projectListForPrincipal(
                { view: 'not-a-view' },
                { kind: 'desktop', id: 'd', generation: 1 },
            ),
        ).toThrow();
    });
});

describe('principalProjectionSchemas.settings', () => {
    it('only exposes the bounded allowlist of settings keys', () => {
        const parsed = principalProjectionSchemas.settings.parse({
            'session.defaultAgent': null,
            'terminal.fontSize': 13,
            'terminal.scrollback': 2_000,
            'terminal.copyOnSelect': true,
            'terminal.gpuAcceleration': 'off',
            'terminal.osc52ClipboardWrite': false,
            'files.maxFileBytes': 2_000_000,
            'some.unrelated.setting': 'must be stripped',
        });
        expect(parsed).not.toHaveProperty('some.unrelated.setting');
    });
});

describe('principalProjectionSchemas.agent', () => {
    it.each(agentProviderIds)('accepts the catalogued %s provider', (provider) => {
        expect(
            principalProjectionSchemas.agent.parse({
                available: true,
                provider,
                status: 'working',
            }),
        ).toMatchObject({ provider });
    });
});
