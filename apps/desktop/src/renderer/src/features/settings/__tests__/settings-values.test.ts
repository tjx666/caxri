import type { AppSettings, ArgvConfig } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isRowModified,
    isRowResettable,
    rowResetAction,
    withProviderField,
} from '../settings-values';

const settings = (): AppSettings => structuredClone(defaultAppSettings);
const argv: ArgvConfig = { hardwareAcceleration: true, remoteDebugging: true };

describe('isRowModified', () => {
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
        expect(isRowResettable({ type: 'provider-skill-health', provider: 'codex' })).toBe(false);
        expect(rowResetAction({ type: 'archived-sessions' }, settings())).toBeUndefined();
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
