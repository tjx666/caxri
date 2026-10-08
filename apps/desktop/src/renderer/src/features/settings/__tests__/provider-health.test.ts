import type { AgentSkillHealth } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    hookHealthLabel,
    hookHealthTone,
    isHookAdapterAvailable,
    skillScopeHealth,
    skillScopeSummary,
    skillScopeTone,
} from '../provider-health';

describe('hookHealthLabel', () => {
    it('reports disabled and pending states before health arrives', () => {
        expect(hookHealthLabel(false, undefined)).toBe('Disabled');
        expect(hookHealthLabel(true, undefined)).toBe('Checking installation…');
    });

    it('maps every health kind to user language and appends the detail message', () => {
        expect(hookHealthLabel(true, { kind: 'active' })).toBe('Active');
        expect(hookHealthLabel(true, { kind: 'notInstalled' })).toBe('Not in effect');
        // Issue #1345: `health.message` already carries the actionable instruction ("Install the {CLI} CLI, then
        // restart Caxri."), so the base label must not restate "install": regression for the duplicated wording.
        expect(
            hookHealthLabel(true, {
                kind: 'notInstalled',
                message: 'Install the Codex CLI, then restart Caxri.',
            }),
        ).toBe('Not in effect — Install the Codex CLI, then restart Caxri.');
        expect(hookHealthLabel(true, { kind: 'installedPending' })).toBe(
            'Not in effect until your next Agent session',
        );
        expect(hookHealthLabel(true, { kind: 'incompatible', installedSchema: 99 })).toBe(
            'Newer installation is incomplete',
        );
        expect(hookHealthLabel(true, { kind: 'stale' })).toContain('restart Agent Terminals');
        expect(hookHealthLabel(true, { kind: 'error', message: 'EPERM' })).toBe(
            'Setup failed — restart Agent Terminals to try again — EPERM',
        );
    });
});

describe('isHookAdapterAvailable', () => {
    it('only refuses the toggle where nothing the user does can make it work', () => {
        expect(isHookAdapterAvailable({ kind: 'unsupported' })).toBe(false);
        // A missing CLI is still installable, so the preference stays the user's to record.
        expect(isHookAdapterAvailable({ kind: 'notInstalled' })).toBe(true);
        expect(isHookAdapterAvailable({ kind: 'active' })).toBe(true);
        expect(isHookAdapterAvailable(undefined)).toBe(true);
    });
});

describe('hookHealthTone', () => {
    it('marks intervention states while leaving healthy and informational states muted', () => {
        expect(hookHealthTone(false, { kind: 'error' })).toBe('muted');
        expect(hookHealthTone(true, undefined)).toBe('muted');
        expect(hookHealthTone(true, { kind: 'active' })).toBe('muted');
        expect(hookHealthTone(true, { kind: 'installedPending' })).toBe('muted');
        // A prerequisite the user has not met yet is not something going wrong; the caption says it plainly instead.
        expect(hookHealthTone(true, { kind: 'notInstalled' })).toBe('muted');
        expect(hookHealthTone(true, { kind: 'incompatible', installedSchema: 99 })).toBe('warning');
        expect(hookHealthTone(true, { kind: 'stale' })).toBe('warning');
        expect(hookHealthTone(true, { kind: 'drifted' })).toBe('warning');
        expect(hookHealthTone(true, { kind: 'conflict' })).toBe('danger');
        expect(hookHealthTone(true, { kind: 'error' })).toBe('danger');
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

describe('skillScopeTone', () => {
    it('colors an installation that needs attention and leaves a healthy one plain', () => {
        const installation = health.installations[0];
        expect(skillScopeTone(installation)).toBe('neutral');
        expect(skillScopeTone({ ...installation, status: 'missing' })).toBe('warning');
        expect(skillScopeTone({ ...installation, status: 'stale' })).toBe('warning');
        expect(skillScopeTone({ ...installation, status: 'conflict' })).toBe('danger');
        expect(skillScopeTone(undefined)).toBe('neutral');
    });
});
