import type { AppSettings, ArgvConfig } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isRowEnabled,
    isRowModified,
    isRowResettable,
    rowResetAction,
    withProviderField,
} from '../settings-values';

const settings = (): AppSettings => structuredClone(defaultAppSettings);
const argv: ArgvConfig = { hardwareAcceleration: true, remoteDebugging: true };

describe('isRowEnabled', () => {
    it('disables a dependent row while the switch it depends on is off', () => {
        const row = { enabledBy: 'terminal.idleSuspension.enabled' as const };
        expect(
            isRowEnabled(row, { ...defaultAppSettings, 'terminal.idleSuspension.enabled': false }),
        ).toBe(false);
        expect(
            isRowEnabled(row, { ...defaultAppSettings, 'terminal.idleSuspension.enabled': true }),
        ).toBe(true);
        expect(isRowEnabled({}, defaultAppSettings)).toBe(true);
    });
});

describe('isRowModified', () => {
    it('tracks and resets Git exclusions independently of file-tree exclusions', () => {
        const current = settings();
        const binding = { type: 'files-exclude', key: 'git.diffExclude' } as const;
        expect(isRowModified(binding, { settings: current })).toBe(false);
        current['git.diffExclude'] = { '**/*.test.*': true };
        expect(isRowModified(binding, { settings: current })).toBe(true);
        expect(rowResetAction(binding, current)).toEqual({
            kind: 'field',
            key: 'git.diffExclude',
            value: defaultAppSettings['git.diffExclude'],
        });
        expect(
            isRowModified({ type: 'files-exclude', key: 'files.exclude' }, { settings: current }),
        ).toBe(false);
    });

    /**
     * The delegation row edits one field of a complex value the user also hand-writes presets into. A reset that took
     * the whole value back to its default would delete that hand-written work without saying so.
     */
    it('tracks the delegation depth without touching hand-written presets', () => {
        const current = settings();
        const binding = { type: 'delegation-depth' } as const;
        current['agents.delegation'] = {
            ...current['agents.delegation'],
            presets: [{ name: 'reviewer', provider: 'codex', useWhen: 'Reviewing a diff' }],
        };
        expect(isRowModified(binding, { settings: current })).toBe(false);
        current['agents.delegation'] = { ...current['agents.delegation'], maxDepth: 5 };
        expect(isRowModified(binding, { settings: current })).toBe(true);
        expect(rowResetAction(binding, current)).toEqual({
            kind: 'field',
            key: 'agents.delegation',
            // Narrows the JSONC write to the depth's own path; writing the whole key would replace its node and take
            // any comment the user left beside those presets with it.
            member: 'maxDepth',
            value: {
                ...current['agents.delegation'],
                maxDepth: defaultAppSettings['agents.delegation'].maxDepth,
            },
        });
    });

    it('flags a scalar setting only when it diverges from its default', () => {
        const current = settings();
        expect(
            isRowModified({ type: 'setting', key: 'terminal.fontSize' }, { settings: current }),
        ).toBe(false);
        current['terminal.fontSize'] = defaultAppSettings['terminal.fontSize'] + 1;
        expect(
            isRowModified({ type: 'setting', key: 'terminal.fontSize' }, { settings: current }),
        ).toBe(true);
    });

    it('tracks provider toggle and launch fields against provider defaults', () => {
        const current = settings();
        const toggle = { type: 'provider-toggle', provider: 'codex', field: 'hooks' } as const;
        expect(isRowModified(toggle, { settings: current })).toBe(false);
        current['agents.providers'] = withProviderField(current, 'codex', {
            hooks: { enabled: !current['agents.providers'].codex.hooks.enabled },
        });
        expect(isRowModified(toggle, { settings: current })).toBe(true);

        const launch = { type: 'provider-launch', provider: 'codex', field: 'args' } as const;
        expect(isRowModified(launch, { settings: current })).toBe(false);
        current['agents.providers'] = withProviderField(current, 'codex', {
            launch: { ...current['agents.providers'].codex.launch, args: ['--foo'] },
        });
        expect(isRowModified(launch, { settings: current })).toBe(true);
    });

    it('tracks provider autonomy only when the bypass itself changes', () => {
        const current = settings();
        const binding = { type: 'provider-autonomy', provider: 'grok' } as const;
        expect(isRowModified(binding, { settings: current })).toBe(false);
        // An unrelated hand-edited argument belongs to the arguments row, not to this one.
        current['agents.providers'] = withProviderField(current, 'grok', {
            launch: {
                ...current['agents.providers'].grok.launch,
                args: [...current['agents.providers'].grok.launch.args, '--verbose'],
            },
        });
        expect(isRowModified(binding, { settings: current })).toBe(false);
        current['agents.providers'] = withProviderField(current, 'grok', {
            launch: {
                ...current['agents.providers'].grok.launch,
                args: ['--sandbox', 'workspace', '--verbose'],
            },
        });
        expect(isRowModified(binding, { settings: current })).toBe(true);

        const action = rowResetAction(binding, current);
        if (action?.kind !== 'field') throw new Error('expected a field reset');
        expect((action.value as AppSettings['agents.providers']).grok.launch.args).toEqual([
            '--yolo',
            '--sandbox',
            'workspace',
            '--verbose',
        ]);
    });

    it('tracks and resets provider output recovery as one setting', () => {
        const current = settings();
        const binding = { type: 'provider-recovery', provider: 'codex' } as const;
        expect(isRowModified(binding, { settings: current })).toBe(false);
        current['agents.providers'].codex.recovery = {
            ...current['agents.providers'].codex.recovery,
            enabled: true,
            patterns: ['API timeout'],
        };
        expect(isRowModified(binding, { settings: current })).toBe(true);

        const action = rowResetAction(binding, current);
        if (action?.kind !== 'field') throw new Error('expected a field reset');
        expect((action.value as AppSettings['agents.providers']).codex.recovery).toEqual(
            defaultAppSettings['agents.providers'].codex.recovery,
        );
    });

    it('treats trusted domains as modified once any rule exists', () => {
        const current = settings();
        expect(isRowModified({ type: 'trusted-domains' }, { settings: current })).toBe(false);
        current['security.trustedDomains'] = ['https://example.com'];
        expect(isRowModified({ type: 'trusted-domains' }, { settings: current })).toBe(true);
    });

    it('treats trusted folders as modified once any rule exists', () => {
        const current = settings();
        expect(isRowModified({ type: 'trusted-folders' }, { settings: current })).toBe(false);
        current['security.trustedFolders'] = ['/Users/me/.config'];
        expect(isRowModified({ type: 'trusted-folders' }, { settings: current })).toBe(true);
    });

    it('treats remote debugging as modified only when the loaded argv config disables it', () => {
        const current = settings();
        expect(isRowModified({ type: 'remote-debugging' }, { settings: current })).toBe(false);
        expect(
            isRowModified({ type: 'remote-debugging' }, { settings: current, argvConfig: argv }),
        ).toBe(false);
        expect(
            isRowModified(
                { type: 'remote-debugging' },
                { settings: current, argvConfig: { ...argv, remoteDebugging: false } },
            ),
        ).toBe(true);
    });

    it('treats hardware acceleration as modified only when the loaded argv config disables it', () => {
        const current = settings();
        expect(isRowModified({ type: 'hardware-acceleration' }, { settings: current })).toBe(false);
        expect(
            isRowModified(
                { type: 'hardware-acceleration' },
                { settings: current, argvConfig: argv },
            ),
        ).toBe(false);
        expect(
            isRowModified(
                { type: 'hardware-acceleration' },
                { settings: current, argvConfig: { ...argv, hardwareAcceleration: false } },
            ),
        ).toBe(true);
    });
});

describe('isRowResettable / rowResetAction', () => {
    it('excludes navigation and health rows from reset', () => {
        expect(isRowResettable({ type: 'archived-sessions' })).toBe(false);
        expect(isRowResettable({ type: 'mobile-access' })).toBe(false);
        expect(isRowResettable({ type: 'provider-skill-health', provider: 'codex' })).toBe(false);
        expect(rowResetAction({ type: 'archived-sessions' }, settings())).toBeUndefined();
        expect(rowResetAction({ type: 'mobile-access' }, settings())).toBeUndefined();
    });

    it('resets trusted folders to an empty list', () => {
        const current = settings();
        current['security.trustedFolders'] = ['/Users/me/.config'];
        expect(rowResetAction({ type: 'trusted-folders' }, current)).toEqual({
            kind: 'field',
            key: 'security.trustedFolders',
            value: [],
        });
    });

    it('resets a scalar setting to its shipped default', () => {
        const current = settings();
        current['terminal.scrollback'] = defaultAppSettings['terminal.scrollback'] + 100;
        expect(rowResetAction({ type: 'setting', key: 'terminal.scrollback' }, current)).toEqual({
            kind: 'field',
            key: 'terminal.scrollback',
            value: defaultAppSettings['terminal.scrollback'],
        });
    });

    it('resets one provider launch field while preserving sibling provider state', () => {
        const current = settings();
        current['agents.providers'] = withProviderField(current, 'codex', {
            launch: {
                ...current['agents.providers'].codex.launch,
                args: ['--x'],
                executable: 'zz',
            },
        });
        const action = rowResetAction(
            { type: 'provider-launch', provider: 'codex', field: 'args' },
            current,
        );
        if (action?.kind !== 'field') throw new Error('expected a field reset');
        const next = action.value as AppSettings['agents.providers'];
        expect(next.codex.launch.args).toEqual(
            defaultAppSettings['agents.providers'].codex.launch.args,
        );
        expect(next.codex.launch.executable).toBe('zz');
        expect(next.claude).toEqual(current['agents.providers'].claude);
    });

    it('resets remote debugging through the argv channel', () => {
        expect(rowResetAction({ type: 'remote-debugging' }, settings())).toEqual({
            kind: 'argv',
            changes: { remoteDebugging: true },
        });
    });

    it('re-enables hardware acceleration through the argv channel', () => {
        expect(rowResetAction({ type: 'hardware-acceleration' }, settings())).toEqual({
            kind: 'argv',
            changes: { hardwareAcceleration: true },
        });
    });
});
