import { describe, expect, it } from 'vitest';

import { claudeHookAdapter } from '../../providers/claude/hooks';
import { codexHookAdapter } from '../../providers/codex/hooks';
import type { AgentHookAdapter, AgentHookBinding, DesiredHookInstall } from '../contract';
import { inspectJsonHooks, removeJsonHooks, renderJsonHooks } from '../json-config';

function desired(provider: 'claude' | 'codex', schemaVersion = 2): DesiredHookInstall {
    return {
        bridgePath: '/Library/Application Support/Caxri/hooks/caxri-agent-hook-bridge',
        provider,
        schemaVersion,
    };
}

function binding(
    event: string,
    phase: AgentHookBinding['phase'],
    matcher?: string,
): AgentHookBinding {
    return matcher ? { event, matcher, phase } : { event, phase };
}

/**
 * Builds a marker-matching owned command string without depending on the private `buildBridgeCommand` helper, so these
 * tests stay at the level of the documented wire contract that `ownedSchema()` parses.
 */
function ownedCommand(provider: 'claude' | 'codex', phase: string, schemaVersion: number): string {
    return `'/bridge' --source caxri --provider ${provider} --phase ${phase} --schema ${schemaVersion}`;
}

function jsonSource(hooks: Record<string, unknown>): string {
    return `${JSON.stringify({ hooks }, null, 2)}\n`;
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
        const stale = current.replaceAll('--schema 3', '--schema 2');
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', stale],
                    ['config', undefined],
                ]),
                desired('codex', 3),
            ).status,
        ).toEqual({ kind: 'stale', installedSchema: 2 });

        const updated = codexHookAdapter.render(
            new Map([
                ['hooks', stale],
                ['config', undefined],
            ]),
            desired('codex', 3),
        )[0].source;
        expect(updated).not.toContain('--schema 2');

        const newer = updated.replaceAll('--schema 3', '--schema 4');
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex', 3),
            ).status,
        ).toEqual({ kind: 'newer', installedSchema: 4 });
        expect(
            codexHookAdapter.remove(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex', 3),
            ),
        ).toHaveLength(0);
    });

    it('installs Codex compaction lifecycle hooks', () => {
        const installed = JSON.parse(install(codexHookAdapter, 'hooks', '{}\n', 'codex')) as {
            hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };

        expect(installed.hooks.PreCompact[0].hooks[0].command).toContain(
            '--phase compactionStarted',
        );
        expect(installed.hooks.PostCompact[0].hooks[0].command).toContain(
            '--phase compactionFinished',
        );
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

    it('does not mistake Codex hook-approval state for inline config.toml hooks', () => {
        // Codex records trusted hashes for hooks.json entries (including the managed ones) under
        // `[hooks.state]`; flagging that bookkeeping as a conflict would permanently block the
        // managed install that produced it.
        const state =
            '[hooks.state]\n\n' +
            '[hooks.state."/Users/example/.codex/hooks.json:stop:0:0"]\n' +
            'trusted_hash = "sha256:aaaa"\n\n' +
            '[hooks.state."/Users/example/.codex/hooks.json:pre_tool_use:1:0"]\n' +
            'trusted_hash = "sha256:bbbb"\n';
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', undefined],
                    ['config', state],
                ]),
                desired('codex'),
            ).status,
        ).toEqual({ kind: 'absent' });
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', undefined],
                    ['config', `${state}\n[[hooks.Stop]]\ncommand = "foreign"\n`],
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

describe('json-config status matrix and partial-group edits', () => {
    it('reports absent when no owned entries are installed for any bound event', () => {
        const bindings = [binding('Stop', 'turnFinished')];

        expect(inspectJsonHooks(undefined, desired('codex'), bindings)).toEqual({
            kind: 'absent',
        });
        expect(inspectJsonHooks('{}\n', desired('codex'), bindings)).toEqual({ kind: 'absent' });
    });

    it('reports current immediately after rendering the desired bindings', () => {
        const bindings = [
            binding('Stop', 'turnFinished'),
            binding('UserPromptSubmit', 'turnStarted'),
        ];
        const installed = renderJsonHooks('target', undefined, desired('codex'), bindings).source;

        expect(inspectJsonHooks(installed, desired('codex'), bindings)).toEqual({
            kind: 'current',
        });
    });

    it('reports drifted when the installed entry count does not match the desired binding count', () => {
        const bindings = [
            binding('Stop', 'turnFinished'),
            binding('UserPromptSubmit', 'turnStarted'),
        ];
        const onlyOneInstalled = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: ownedCommand('codex', 'turnFinished', 2),
                            timeout: 1,
                        },
                    ],
                },
            ],
        });

        expect(inspectJsonHooks(onlyOneInstalled, desired('codex'), bindings)).toEqual({
            kind: 'drifted',
        });
    });

    it('reports drifted when an owned handler shares its group with a foreign handler', () => {
        const bindings = [binding('Stop', 'turnFinished')];
        const mixedGroup = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: ownedCommand('codex', 'turnFinished', 2),
                            timeout: 1,
                        },
                        { type: 'command', command: '/usr/local/bin/foreign-hook' },
                    ],
                },
            ],
        });

        expect(inspectJsonHooks(mixedGroup, desired('codex'), bindings)).toEqual({
            kind: 'drifted',
        });
    });

    it('removes only the owned handler from a shared group and keeps the foreign handler in place', () => {
        const mixedGroup = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: ownedCommand('codex', 'turnFinished', 2),
                            timeout: 1,
                        },
                        { type: 'command', command: '/usr/local/bin/foreign-hook' },
                    ],
                },
            ],
        });

        const edits = removeJsonHooks('target', mixedGroup, desired('codex'));

        expect(edits).toHaveLength(1);
        const remaining = JSON.parse(edits[0].source) as {
            hooks: { Stop: Array<{ hooks: unknown[] }> };
        };
        expect(remaining.hooks.Stop).toHaveLength(1);
        expect(remaining.hooks.Stop[0].hooks).toEqual([
            { type: 'command', command: '/usr/local/bin/foreign-hook' },
        ]);
    });

    it('removes an entire group and prunes the event key once every handler in it is owned', () => {
        const ownedOnlyGroup = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: ownedCommand('codex', 'turnFinished', 2),
                            timeout: 1,
                        },
                    ],
                },
            ],
        });

        const edits = removeJsonHooks('target', ownedOnlyGroup, desired('codex'));

        expect(edits).toHaveLength(1);
        expect(JSON.parse(edits[0].source)).toEqual({});
    });

    it('reports stale using the minimum installed schema when every entry is older than desired', () => {
        const bindings = [
            binding('Stop', 'turnFinished'),
            binding('UserPromptSubmit', 'turnStarted'),
        ];
        const current = renderJsonHooks('target', undefined, desired('codex'), bindings).source;
        const allStale = current.replaceAll('--schema 2', '--schema 1');

        expect(inspectJsonHooks(allStale, desired('codex'), bindings)).toEqual({
            kind: 'stale',
            installedSchema: 1,
        });
    });

    it('reports newer using the maximum installed schema across mixed stale and newer entries', () => {
        const bindings = [
            binding('Stop', 'turnFinished'),
            binding('UserPromptSubmit', 'turnStarted'),
        ];
        const current = renderJsonHooks('target', undefined, desired('codex'), bindings).source;
        const mixedSchemas = current
            .replace('--phase turnFinished --schema 2', '--phase turnFinished --schema 1')
            .replace('--phase turnStarted --schema 2', '--phase turnStarted --schema 3');

        expect(inspectJsonHooks(mixedSchemas, desired('codex'), bindings)).toEqual({
            kind: 'newer',
            installedSchema: 3,
        });
    });
});
