import type { ProjectRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    defaultSecretScope,
    isValidSecretName,
    scopeFromValue,
    scopeValue,
    secretScopeProjects,
    sortSecrets,
} from '../agent-secrets-summary';

const project = (id: string, ownerProjectId?: string) =>
    ({ id, title: id.toUpperCase(), ...(ownerProjectId && { ownerProjectId }) }) as ProjectRecord;

describe('agent secret presentation', () => {
    it('defaults a new secret to the selected Project, or its owner for a worktree', () => {
        expect(defaultSecretScope(undefined)).toEqual({ kind: 'global' });
        expect(defaultSecretScope(project('a'))).toEqual({ kind: 'project', projectId: 'a' });
        expect(defaultSecretScope(project('wt', 'a'))).toEqual({ kind: 'project', projectId: 'a' });
    });

    it('offers only top-level Projects as scopes', () => {
        expect(secretScopeProjects([project('a'), project('wt', 'a')]).map(({ id }) => id)).toEqual(
            ['a'],
        );
    });

    it('round-trips scopes through the Select value', () => {
        for (const scope of [
            { kind: 'global' } as const,
            { kind: 'project', projectId: 'a' } as const,
        ])
            expect(scopeFromValue(scopeValue(scope))).toEqual(scope);
    });

    it('lists global secrets first, then each Project by title', () => {
        const sorted = sortSecrets(
            [
                { name: 'B', scope: { kind: 'project', projectId: 'b' }, updatedAt: 1 },
                { name: 'Z', scope: { kind: 'global' }, updatedAt: 1 },
                { name: 'A', scope: { kind: 'project', projectId: 'a' }, updatedAt: 1 },
                { name: 'A', scope: { kind: 'global' }, updatedAt: 1 },
            ],
            (id) => id.toUpperCase(),
        );
        expect(sorted.map(({ name, scope }) => `${scope.kind}:${name}`)).toEqual([
            'global:A',
            'global:Z',
            'project:A',
            'project:B',
        ]);
    });

    it('accepts environment variable names and refuses reserved ones', () => {
        expect(isValidSecretName('API_TOKEN')).toBe(true);
        expect(isValidSecretName('9TOKEN')).toBe(false);
        expect(isValidSecretName('CAXRI_TOKEN')).toBe(false);
        expect(isValidSecretName('PATH')).toBe(false);
    });
});
