import type { AppSettings, Keybinding, ThemeTokens } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ConfigAction, ConfigState } from '../settings-drafts';
import { configReducer, initialConfigState, parseConfigSource } from '../settings-drafts';

const SETTINGS_SOURCE = `{
  // This comment must survive a source-to-UI round trip.
  "session.defaultAgent": null,
  "agents.providers": {
    "claude": { "launch": { "executable": "claude", "args": [] } },
    "codex": { "launch": { "executable": "codex", "args": [] } }
  },
  "terminal.defaultWorkingDirectory": null,
  "terminal.fontSize": 17,
  "terminal.scrollback": 2000,
  "files.exclude": {},
  "files.maxFileBytes": 1048576,
}
`;

function loadedState(): ConfigState {
    return configReducer(initialConfigState, {
        type: 'loaded',
        settings: {
            value: { 'terminal.fontSize': 13 } as AppSettings,
            source: 'settings baseline',
        },
        keybindings: { value: [], source: 'keybindings baseline', conflicts: [] },
        theme: { value: {} as ThemeTokens, source: 'theme baseline' },
    });
}

function pendingAction(kind: keyof ConfigState): ConfigAction {
    if (kind === 'settings')
        return {
            type: 'settings/changed',
            value: { 'terminal.fontSize': 19 } as AppSettings,
            source: 'settings pending',
        };
    if (kind === 'keybindings')
        return {
            type: 'keybindings/changed',
            value: [{ command: 'editor.save', key: 'cmd+s' }],
            source: 'keybindings pending',
        };
    return {
        type: 'theme/changed',
        value: { id: 'pending-theme' } as ThemeTokens,
        source: 'theme pending',
    };
}

function echoAction(kind: keyof ConfigState): ConfigAction {
    if (kind === 'settings') return { type: 'settings/echoApplied', source: 'settings persisted' };
    if (kind === 'keybindings')
        return { type: 'keybindings/echoApplied', source: 'keybindings persisted' };
    return { type: 'theme/echoApplied', source: 'theme persisted' };
}

function reconciledAction(kind: keyof ConfigState): ConfigAction {
    if (kind === 'settings')
        return {
            type: 'settings/reconciled',
            value: { 'terminal.fontSize': 15 } as AppSettings,
            source: 'settings authoritative',
        };
    if (kind === 'keybindings')
        return {
            type: 'keybindings/reconciled',
            value: [{ command: 'editor.close', key: 'cmd+w' }] satisfies Keybinding[],
            source: 'keybindings authoritative',
            conflicts: [],
        };
    return {
        type: 'theme/reconciled',
        value: { id: 'authoritative-theme' } as ThemeTokens,
        source: 'theme authoritative',
    };
}

describe('parseConfigSource', () => {
    it('parses a legal JSONC Settings draft without normalizing its comments', () => {
        const result = parseConfigSource('settings', SETTINGS_SOURCE);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(result.value['terminal.fontSize']).toBe(17);
        expect(SETTINGS_SOURCE).toContain('// This comment must survive');
    });

    it('returns a readable location for invalid JSONC', () => {
        const result = parseConfigSource('settings', '{\n  "terminal.fontSize": nope\n}');

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Expected invalid JSONC');
        expect(result.error).toMatch(/settings\.jsonc: .*line 2, column 24/);
    });

    it('validates keybinding source before the structured editor consumes it', () => {
        expect(
            parseConfigSource(
                'keybindings',
                '[\n  // Keep my shortcut note.\n  { "key": "cmd+s", "command": "editor.save" },\n]\n',
            ),
        ).toEqual({
            ok: true,
            value: [{ key: 'cmd+s', command: 'editor.save' }],
        });
    });

    it('accepts the same omitted default fields as the Runtime Settings parser', () => {
        const result = parseConfigSource('settings', '{ "terminal.fontSize": 18 }');

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(result.value['terminal.fontSize']).toBe(18);
        expect(result.value['terminal.scrollback']).toBe(2000);
        expect(result.value['terminal.gpuAcceleration']).toBe('off');
        expect(result.value['agents.providers'].claude.launch.executable).toBe('claude');
        expect(result.value['agents.providers'].claude.hooks.enabled).toBe(false);
    });

    it('rejects unsupported Terminal GPU acceleration values', () => {
        const result = parseConfigSource('settings', '{ "terminal.gpuAcceleration": "force" }');

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Expected invalid Terminal GPU acceleration');
        expect(result.error).toContain('terminal.gpuAcceleration');
    });
});

describe('configReducer source synchronization', () => {
    it('keeps the last valid value and applied baseline while source is incomplete', () => {
        const state = configReducer(loadedState(), {
            type: 'settings/sourceChanged',
            source: '{ incomplete',
        });

        expect(state.settings.value?.['terminal.fontSize']).toBe(13);
        expect(state.settings.source).toBe('{ incomplete');
        expect(state.settings.appliedSource).toBe('settings baseline');
    });

    it('refreshes the structured value without replacing source text or its dirty baseline', () => {
        const withSource = configReducer(loadedState(), {
            type: 'settings/sourceChanged',
            source: SETTINGS_SOURCE,
        });
        const parsed = parseConfigSource('settings', SETTINGS_SOURCE);
        if (!parsed.ok) throw new Error(parsed.error);

        const synchronized = configReducer(withSource, {
            type: 'settings/sourceParsed',
            value: parsed.value,
        });

        expect(synchronized.settings.value?.['terminal.fontSize']).toBe(17);
        expect(synchronized.settings.source).toBe(SETTINGS_SOURCE);
        expect(synchronized.settings.appliedSource).toBe('settings baseline');
    });

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'advances the %s echo baseline without replacing a newer pending draft',
        (kind) => {
            const pending = configReducer(loadedState(), pendingAction(kind));
            const pendingValue = pending[kind].value;

            const echoed = configReducer(pending, echoAction(kind));

            expect(echoed[kind].source).toBe(`${kind} pending`);
            expect(echoed[kind].value).toBe(pendingValue);
            expect(echoed[kind].appliedSource).toBe(`${kind} persisted`);
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'keeps the pending %s draft while an authoritative re-read advances its baseline',
        (kind) => {
            const pending = configReducer(loadedState(), pendingAction(kind));
            const pendingValue = pending[kind].value;

            const reconciled = configReducer(pending, reconciledAction(kind));

            expect(reconciled[kind].source).toBe(`${kind} pending`);
            expect(reconciled[kind].value).toBe(pendingValue);
            expect(reconciled[kind].appliedSource).toBe(`${kind} authoritative`);
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'replaces a clean %s buffer from the authoritative recovery read',
        (kind) => {
            const clean = loadedState();
            const reconciled = configReducer(clean, reconciledAction(kind));

            expect(reconciled[kind].source).toBe(`${kind} authoritative`);
            expect(reconciled[kind].appliedSource).toBe(`${kind} authoritative`);
            expect(reconciled[kind].value).not.toBe(clean[kind].value);
        },
    );
});
