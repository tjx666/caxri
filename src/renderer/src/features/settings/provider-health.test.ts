import type { AgentSkillHealth } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { hookHealthLabel, skillScopeHealth, skillScopeSummary } from './provider-health';

describe('hookHealthLabel', () => {
    it('reports disabled and pending states before health arrives', () => {
        expect(hookHealthLabel(false, undefined)).toBe('Disabled');
        expect(hookHealthLabel(true, undefined)).toBe('Checking installation…');
    });

    it('maps every health kind to user language and appends the detail message', () => {
        expect(hookHealthLabel(true, { kind: 'active' })).toBe('Active');
        expect(hookHealthLabel(true, { kind: 'stale' })).toContain('restart Agent Terminals');
        expect(hookHealthLabel(true, { kind: 'error', message: 'EPERM' })).toBe(
            'Setup failed — restart Agent Terminals to try again — EPERM',
        );
    });
});

const health: AgentSkillHealth = {
    bundled: {
        bundledVersion: '1.2.3',
        compatibility: { cliVersion: '1.2.3', protocolVersion: 1 },
        contentHash: `sha256:${'a'.repeat(64)}`,
        files: ['SKILL.md'],
        name: 'caxri-cli',
        schemaVersion: 1,
    },
    installations: [
        {
            action: 'No action needed',
            bundledVersion: '1.2.3',
            compatible: true,
            installedVersion: '1.2.3',
            name: 'caxri-cli',
            protocolVersion: 1,
            provider: 'codex',
            reason: 'matches-bundle',
            scope: 'global',
            status: 'compatible',
        },
    ],
    selectedProjectId: 'p1',
};

describe('skillScopeHealth / skillScopeSummary', () => {
    it('finds the installation for a provider and scope', () => {
        expect(skillScopeHealth(health, 'codex', 'global')?.installedVersion).toBe('1.2.3');
        expect(skillScopeHealth(health, 'codex', 'local')).toBeUndefined();
    });

    it('summarizes loading, missing-project, uninspectable, and installed states', () => {
        expect(skillScopeSummary(undefined, undefined, 'global')).toBe(
            'Global · Checking installation…',
        );
        expect(
            skillScopeSummary({ ...health, selectedProjectId: undefined }, undefined, 'local'),
        ).toBe('Project local · Select a Project to inspect');
        expect(skillScopeSummary(health, undefined, 'global')).toBe(
            'Global · Unable to inspect this location',
        );
        expect(skillScopeSummary(health, health.installations[0], 'global')).toBe(
            'Global · Compatible · installed v1.2.3',
        );
    });
});
