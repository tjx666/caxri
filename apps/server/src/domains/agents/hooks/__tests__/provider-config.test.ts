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
    it('keeps an unrepresentable schema out of health while preserving its file', () => {
        const bindings = [binding('Stop', 'turnFinished')];
        const source = renderJsonHooks(
            'target',
            undefined,
            desired('codex', 3),
            bindings,
        ).source.replace('--schema 3', '--schema 999999999999999999999999999999999');
        expect(inspectJsonHooks(source, desired('codex'), bindings)).toMatchObject({
            kind: 'unparseable',
        });
        expect(removeJsonHooks('target', source, desired('codex'))).toEqual([]);
    });
    it('preserves but does not endorse a newer schema with a missing required binding', () => {
        const required = [
            binding('Stop', 'turnFinished'),
            binding('UserPromptSubmit', 'turnStarted'),
        ];
        const source = renderJsonHooks(
            'target',
            undefined,
            desired('codex', 3),
            required.slice(0, 1),
        ).source;
        expect(inspectJsonHooks(source, desired('codex'), required)).toEqual({
            kind: 'newerIncomplete',
            installedSchema: 3,
        });
        expect(removeJsonHooks('target', source, desired('codex'))).toEqual([]);
    });
    it('repairs an owned group in place without changing positional trust keys for neighboring hooks', () => {
        interface Document {
            hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
        }
        const parse = (source: string) => JSON.parse(source) as Document;
        const original = parse(install(codexHookAdapter, 'hooks', '{}\n', 'codex'));
        const owned = original.hooks.UserPromptSubmit[0];
        const foreign = { hooks: [{ type: 'command', command: '/synthetic/user-hook' }] };
        original.hooks.UserPromptSubmit = [owned, foreign];
        const unchanged = codexHookAdapter.render(
            new Map([['hooks', JSON.stringify(original)]]),
            desired('codex', codexHookAdapter.schemaVersion),
        )[0].source;
        expect(parse(unchanged).hooks.UserPromptSubmit).toEqual([owned, foreign]);
        owned.hooks[0].command = owned.hooks[0].command.replace(
            `--schema ${codexHookAdapter.schemaVersion}`,
            '--schema 7',
        );
        const repaired = codexHookAdapter.render(
            new Map([['hooks', JSON.stringify(original)]]),
            desired('codex', codexHookAdapter.schemaVersion),
        )[0].source;
        expect(parse(repaired).hooks.UserPromptSubmit[1]).toEqual(foreign);
        expect(parse(repaired).hooks.UserPromptSubmit[0].hooks[0].command).toContain(
            `--schema ${codexHookAdapter.schemaVersion}`,
        );
    });
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
        const installedHooks = (
            JSON.parse(installed) as unknown as { hooks: Record<string, unknown[]> }
        ).hooks;

        expect(
            claudeHookAdapter.inspect(
                new Map([['settings', installed]]),
                desired('claude', claudeHookAdapter.schemaVersion),
            ).status,
        ).toEqual({ kind: 'current' });
        expect(installedHooks.PostToolUse).toHaveLength(1);
        expect(installedHooks.PostToolUse[0]).toMatchObject({ matcher: '^Bash$' });
        expect(installedHooks.PostToolBatch).toHaveLength(1);
        expect(installedHooks.PostToolUseFailure).toHaveLength(1);

        const removed = claudeHookAdapter.remove(
            new Map([['settings', installed]]),
            desired('claude', claudeHookAdapter.schemaVersion),
        )[0].source;
        expect(JSON.parse(removed)).toEqual(foreign);
    });

    it("keeps each provider's own personal hooks when Caxri installs its entries", () => {
        const claudeSource = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: '/Users/example/.claude/hooks/auto-session-name.js',
                        },
                    ],
                },
            ],
        });
        const codexSource = jsonSource({
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: '/Users/example/.codex/hooks/auto-thread-name.js',
                        },
                    ],
                },
            ],
        });

        expect(install(claudeHookAdapter, 'settings', claudeSource, 'claude')).toContain(
            'auto-session-name.js',
        );
        expect(install(codexHookAdapter, 'hooks', codexSource, 'codex')).toContain(
            'auto-thread-name.js',
        );
    });

    it('updates only stale Caxri entries and leaves a newer Codex schema untouched', () => {
        const current = install(codexHookAdapter, 'hooks', '{}\n', 'codex');
        const stale = current.replaceAll(
            `--schema ${codexHookAdapter.schemaVersion}`,
            '--schema 7',
        );
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', stale],
                    ['config', undefined],
                ]),
                desired('codex', codexHookAdapter.schemaVersion),
            ).status,
        ).toEqual({ kind: 'stale', installedSchema: 7 });

        const updated = codexHookAdapter.render(
            new Map([
                ['hooks', stale],
                ['config', undefined],
            ]),
            desired('codex', codexHookAdapter.schemaVersion),
        )[0].source;
        expect(updated).not.toContain('--schema 7');

        const newer = updated.replaceAll(
            `--schema ${codexHookAdapter.schemaVersion}`,
            () => `--schema ${codexHookAdapter.schemaVersion + 1}`,
        );
        expect(
            codexHookAdapter.inspect(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex', codexHookAdapter.schemaVersion),
            ).status,
        ).toEqual({ kind: 'newer', installedSchema: codexHookAdapter.schemaVersion + 1 });
        expect(
            codexHookAdapter.remove(
                new Map([
                    ['hooks', newer],
                    ['config', undefined],
                ]),
                desired('codex', codexHookAdapter.schemaVersion),
            ),
        ).toHaveLength(0);
    });

    it.each([
        {
            adapter: codexHookAdapter,
            previousSchema: codexHookAdapter.schemaVersion - 1,
            provider: 'codex' as const,
            target: 'hooks',
        },
        {
            adapter: claudeHookAdapter,
            previousSchema: claudeHookAdapter.schemaVersion - 1,
            provider: 'claude' as const,
            target: 'settings',
        },
    ])(
        'keeps the new $provider timeout definition safe from a previous manager',
        ({ adapter, previousSchema, provider, target }) => {
            const installed = install(adapter, target, '{}\n', provider);

            expect(
                adapter.inspect(
                    new Map([
                        [target, installed],
                        ['config', undefined],
                    ]),
                    desired(provider, previousSchema),
                ).status,
            ).toEqual({ kind: 'newer', installedSchema: previousSchema + 1 });
        },
    );

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

    it('installs a Codex session-start hook that identifies startup and resumed threads', () => {
        const installed = JSON.parse(install(codexHookAdapter, 'hooks', '{}\n', 'codex')) as {
            hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
        };

        expect(installed.hooks.SessionStart[0].hooks[0].command).toContain(
            '--phase sessionIdentified',
        );
        expect(installed.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
    });

    it('installs paired Bash hooks and a Claude failure cleanup hook', () => {
        const codex = JSON.parse(install(codexHookAdapter, 'hooks', '{}\n', 'codex')) as {
            hooks: Record<string, Array<{ matcher?: string }>>;
        };
        const claude = JSON.parse(install(claudeHookAdapter, 'settings', '{}\n', 'claude')) as {
            hooks: Record<string, Array<{ matcher?: string }>>;
        };

        expect(codex.hooks.PreToolUse).toEqual([
            expect.objectContaining({ matcher: '^Bash$' }),
            expect.objectContaining({ matcher: '^request_user_input$' }),
        ]);
        expect(codex.hooks.PostToolUse).toEqual([
            expect.objectContaining({ matcher: '^Bash$' }),
            expect.objectContaining({ matcher: '^request_user_input$' }),
        ]);
        expect(claude.hooks.PreToolUse).toEqual([
            expect.objectContaining({ matcher: '^AskUserQuestion$' }),
            expect.objectContaining({ matcher: '^Bash$' }),
        ]);
        expect(claude.hooks.PostToolUse).toEqual([expect.objectContaining({ matcher: '^Bash$' })]);
        expect(claude.hooks.PostToolUseFailure).toEqual([
            expect.objectContaining({ matcher: '^Bash$' }),
        ]);
        expect(claude.hooks.SubagentStart).toHaveLength(1);
        expect(claude.hooks.SubagentStop).toHaveLength(1);
    });

    it.each([
        ['a stale install', 9],
        ['a current-schema install missing the question hook', 10],
    ])('converges %s when one event carries several Claude bindings', (_label, installedSchema) => {
        interface Document {
            hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
        }
        const current = desired('claude', claudeHookAdapter.schemaVersion);
        const complete = JSON.parse(
            install(claudeHookAdapter, 'settings', '{}\n', 'claude'),
        ) as Document;
        /**
         * Builds that predate the `^AskUserQuestion$` binding left exactly one owned `PreToolUse` group, beside the
         * user's own `PreToolUse` hooks. Repairing it in place once overwrote that group with each same-event binding
         * in turn, never appended the missing one, and rewrote the file forever.
         */
        const foreign = { matcher: 'Bash', hooks: [{ command: '/synthetic/user-hook' }] };
        for (const groups of Object.values(complete.hooks))
            for (const group of groups)
                group.hooks[0].command = group.hooks[0].command.replace(
                    `--schema ${claudeHookAdapter.schemaVersion}`,
                    () => `--schema ${installedSchema}`,
                );
        complete.hooks.PreToolUse = [
            foreign,
            complete.hooks.PreToolUse.find((group) => group.matcher === '^Bash$')!,
        ];
        const source = `${JSON.stringify(complete, null, 2)}\n`;

        const repaired = claudeHookAdapter.render(new Map([['settings', source]]), current)[0]
            .source;

        expect(
            claudeHookAdapter.inspect(new Map([['settings', repaired]]), current).status,
        ).toEqual({ kind: 'current' });
        expect((JSON.parse(repaired) as Document).hooks.PreToolUse[0]).toEqual(foreign);
        expect(claudeHookAdapter.render(new Map([['settings', repaired]]), current)[0].source).toBe(
            repaired,
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
