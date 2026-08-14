import { describe, expect, it } from 'vitest';

import { claudeHookAdapter } from '../../providers/claude/hooks';
import { codexHookAdapter } from '../../providers/codex/hooks';
import type { AgentHookAdapter, DesiredHookInstall } from '../contract';

function desired(provider: 'claude' | 'codex', schemaVersion = 2): DesiredHookInstall {
    return {
        bridgePath: '/Library/Application Support/Caxri/hooks/caxri-agent-hook-bridge',
        provider,
        schemaVersion,
    };
}

function install(
    adapter: AgentHookAdapter,
    targetId: string,
    source: string,
    provider: 'claude' | 'codex',
): string {
    return adapter.render(
        new Map([[targetId, source]]),
        desired(provider, adapter.schemaVersion),
    )[0].source;
}

describe('Agent provider hook configuration adapters', () => {
    it.each([
        '{ "hooks": false }',
        '{ "hooks": [] }',
        '{ "hooks": { "Stop": false } }',
        '{ "hooks": { "Stop": [{ "hooks": false }] } }',
    ])('fails closed for a malformed hook tree: %s', (source) => {
        expect(
            claudeHookAdapter.inspect(new Map([['settings', source]]), desired('claude')).status,
        ).toMatchObject({ kind: 'unparseable' });
    });

    it('preserves foreign Claude Code hooks across install and uninstall', () => {
        const foreign = {
            hooks: {
                Stop: [
                    {
                        matcher: 'foreign',
                        hooks: [{ type: 'command', command: '/usr/local/bin/foreign-hook' }],
                    },
                ],
            },
            permissions: { allow: ['Read'] },
        };
        const source = `${JSON.stringify(foreign, null, 2)}\n`;
        const installed = install(claudeHookAdapter, 'settings', source, 'claude');

        expect(
            claudeHookAdapter.inspect(new Map([['settings', installed]]), desired('claude')).status,
        ).toEqual({ kind: 'current' });

        const removed = claudeHookAdapter.remove(
            new Map([['settings', installed]]),
            desired('claude'),
        )[0].source;
        expect(JSON.parse(removed)).toEqual(foreign);
    });

    it('updates only stale Caxri entries and leaves a newer Codex schema untouched', () => {
        const current = install(codexHookAdapter, 'hooks', '{}\n', 'codex');
        const stale = current.replaceAll('--schema 2', '--schema 1');
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', stale],
                    ['config', undefined],
                ]),
                desired('codex'),
            ).status,
        ).toEqual({ kind: 'stale', installedSchema: 1 });

        const updated = codexHookAdapter.render(
            new Map([
                ['hooks', stale],
                ['config', undefined],
            ]),
            desired('codex'),
        )[0].source;
        expect(updated).not.toContain('--schema 1');

        const newer = updated.replaceAll('--schema 2', '--schema 3');
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex'),
            ).status,
        ).toEqual({ kind: 'newer', installedSchema: 3 });
        expect(
            codexHookAdapter.remove(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex'),
            ),
        ).toHaveLength(0);
    });

    it('refuses to merge Codex hooks.json with inline config.toml hooks', () => {
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', undefined],
                    ['config', '[[hooks.Stop]]\ncommand = "foreign"\n'],
                ]),
                desired('codex'),
            ).status,
        ).toEqual({
            kind: 'conflict',
            message: 'Codex already defines inline hooks in config.toml',
        });
    });

    it('reports provider-level policies that disable Caxri lifecycle hooks', () => {
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', undefined],
                    ['config', '[features]\nhooks = false\n'],
                ]),
                desired('codex'),
            ).status,
        ).toEqual({
            kind: 'conflict',
            message: 'Codex hooks are disabled in config.toml',
        });
        expect(
            claudeHookAdapter.inspect(
                new Map([['settings', '{ "disableAllHooks": true }']]),
                desired('claude'),
            ).status,
        ).toEqual({
            kind: 'conflict',
            message: 'Claude Code hooks are disabled in settings.json',
        });
    });

    it('never rewrites a malformed provider configuration', () => {
        expect(
            claudeHookAdapter.inspect(new Map([['settings', '{ "hooks": ']]), desired('claude'))
                .status,
        ).toMatchObject({ kind: 'unparseable' });
    });
});
