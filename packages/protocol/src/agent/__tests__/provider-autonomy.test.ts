import { describe, expect, it } from 'vitest';

import { agentProviderCatalog, agentProviderIds, defaultAgentProviderSettings } from '../agents.js';
import {
    hasDefaultProviderAutonomy,
    hasProviderAutonomy,
    withProviderAutonomy,
} from '../provider-autonomy.js';

describe('hasProviderAutonomy', () => {
    it('reads every shipped provider as launching without per-action approval', () => {
        for (const provider of agentProviderIds) {
            expect(
                hasProviderAutonomy(defaultAgentProviderSettings[provider].launch.args, provider),
            ).toBe(true);
            expect(hasDefaultProviderAutonomy(provider)).toBe(true);
        }
    });

    it('reads empty and unrelated arguments as asking first', () => {
        expect(hasProviderAutonomy([], 'claude')).toBe(false);
        expect(hasProviderAutonomy(['--model', 'opus'], 'claude')).toBe(false);
        expect(hasProviderAutonomy(['--dangerously-skip-permissions'], 'codex')).toBe(false);
    });

    it('ignores a token that only looks like the bypass', () => {
        expect(hasProviderAutonomy(['--always-approve-nothing'], 'grok')).toBe(false);
    });

    it('treats Grok Build --always-approve as the same bypass as --yolo', () => {
        expect(hasProviderAutonomy(['--yolo'], 'grok')).toBe(true);
        expect(hasProviderAutonomy(['--always-approve', '--sandbox', 'workspace'], 'grok')).toBe(
            true,
        );
        expect(hasProviderAutonomy(['--yolo --sandbox workspace'], 'grok')).toBe(true);
    });
});

describe('withProviderAutonomy', () => {
    it('removes only the bypass and keeps every other argument in order', () => {
        expect(
            withProviderAutonomy(
                ['--verbose', '--dangerously-skip-permissions', '--model', 'opus'],
                'claude',
                false,
            ),
        ).toEqual(['--verbose', '--model', 'opus']);
        expect(
            withProviderAutonomy(
                ['--dangerously-bypass-approvals-and-sandbox', '--profile', 'work'],
                'codex',
                false,
            ),
        ).toEqual(['--profile', 'work']);
    });

    it('leaves a hand-added Grok Build --sandbox workspace in both directions', () => {
        const withSandbox = ['--yolo', '--sandbox', 'workspace'];
        const off = withProviderAutonomy(withSandbox, 'grok', false);
        expect(off).toEqual(['--sandbox', 'workspace']);
        expect(withProviderAutonomy(off, 'grok', true)).toEqual(withSandbox);
        expect(withProviderAutonomy(['--yolo', '--sandbox workspace'], 'grok', false)).toEqual([
            '--sandbox',
            'workspace',
        ]);
        expect(withProviderAutonomy(['--yolo', '--model', 'opus 4'], 'grok', false)).toEqual([
            '--model',
            'opus 4',
        ]);
    });

    it('drops a persisted Grok Build --always-approve without inserting a second --yolo', () => {
        const persisted = ['--always-approve', '--sandbox', 'workspace', '--verbose'];
        expect(withProviderAutonomy(persisted, 'grok', true)).toEqual(persisted);
        expect(withProviderAutonomy(persisted, 'grok', false)).toEqual([
            '--sandbox',
            'workspace',
            '--verbose',
        ]);
    });

    it('restores the bypass ahead of the arguments the user kept', () => {
        expect(withProviderAutonomy(['--model', 'opus'], 'claude', true)).toEqual([
            '--dangerously-skip-permissions',
            '--model',
            'opus',
        ]);
    });

    it('never duplicates or re-positions a bypass that is already present', () => {
        const arguments_ = ['--verbose', '--dangerously-skip-permissions', '--model', 'opus'];
        expect(withProviderAutonomy(arguments_, 'claude', true)).toEqual(arguments_);
    });

    it('drops a hand-written duplicate bypass when turned off', () => {
        expect(
            withProviderAutonomy(
                [
                    '--dangerously-skip-permissions',
                    '--verbose',
                    '--dangerously-skip-permissions',
                    '--dangerously-skip-permissions',
                ],
                'claude',
                false,
            ),
        ).toEqual(['--verbose']);
    });

    it('changes nothing when the requested state already holds', () => {
        expect(withProviderAutonomy(['--model', 'opus'], 'claude', false)).toEqual([
            '--model',
            'opus',
        ]);
    });

    it('never mutates the arguments it was given', () => {
        const arguments_ = Object.freeze(['--dangerously-skip-permissions', '--verbose']);
        expect(withProviderAutonomy(arguments_, 'claude', false)).toEqual(['--verbose']);
        expect(arguments_).toEqual(['--dangerously-skip-permissions', '--verbose']);
    });

    it('round-trips every provider back to its shipped launch arguments', () => {
        for (const provider of agentProviderIds) {
            const shipped = defaultAgentProviderSettings[provider].launch.args;
            const off = withProviderAutonomy(shipped, provider, false);
            expect(hasProviderAutonomy(off, provider)).toBe(false);
            const bypass = agentProviderCatalog[provider].autonomyArgs;
            for (const token of bypass) {
                expect(off).not.toContain(token);
            }
            expect(withProviderAutonomy(off, provider, true)).toEqual([...shipped]);
        }
    });
});
