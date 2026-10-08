import { expect, it } from 'vitest';

import { codexHookAdapter } from '../../providers/codex/hooks';
import { inspectJsonHooks } from '../json-config';

it('installs paired Codex question hooks and repairs an incomplete installation', () => {
    const desired = {
        bridgePath: '/synthetic/bridge',
        provider: 'codex' as const,
        schemaVersion: codexHookAdapter.schemaVersion,
    };
    const source = codexHookAdapter.render(new Map([['hooks', '{}\n']]), desired)[0].source;
    const installed = JSON.parse(source) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    for (const [event, phase] of [
        ['PreToolUse', 'attentionRequested'],
        ['PostToolUse', 'attentionResolved'],
    ]) {
        const matching = installed.hooks[event].filter(
            (group) => !group.matcher || new RegExp(group.matcher).test('request_user_input'),
        );
        expect(matching).toHaveLength(1);
        expect(matching[0].hooks[0].command).toContain(`--phase ${phase}`);
    }
    installed.hooks.PreToolUse = installed.hooks.PreToolUse.filter(
        (group) => group.matcher === '^Bash$',
    );
    const incomplete = new Map([['hooks', JSON.stringify(installed)]]);
    expect(codexHookAdapter.inspect(incomplete, desired).status.kind).toBe('drifted');
    const repaired = codexHookAdapter.render(incomplete, desired)[0].source;
    expect(codexHookAdapter.inspect(new Map([['hooks', repaired]]), desired).status.kind).toBe(
        'current',
    );
});

it('keeps question bindings installed when a schema-8 build reconciles the shared file', () => {
    const current = {
        bridgePath: '/synthetic/bridge',
        provider: 'codex' as const,
        schemaVersion: codexHookAdapter.schemaVersion,
    };
    const source = codexHookAdapter.render(new Map([['hooks', '{}']]), current)[0].source;
    const older = { ...current, schemaVersion: 8 };
    const olderBindings = codexHookAdapter.bindings.filter(
        (binding) => binding.matcher !== '^request_user_input$',
    );
    expect(inspectJsonHooks(source, older, olderBindings)).toEqual({
        kind: 'newer',
        installedSchema: current.schemaVersion,
    });
});
