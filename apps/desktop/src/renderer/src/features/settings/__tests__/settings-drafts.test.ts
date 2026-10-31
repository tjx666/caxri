import type { AppSettings, Keybinding } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ConfigAction, ConfigState } from '../settings-drafts';
import {
    configReducer,
    initialConfigState,
    invalidSourceDraft,
    parseConfigSource,
} from '../settings-drafts';

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
        theme: {
            value: { ...draculaTheme, id: 'baseline-theme' },
            source: 'theme baseline',
        },
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
        value: { ...draculaTheme, id: 'pending-theme' },
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
        value: { ...draculaTheme, id: 'authoritative-theme' },
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
        expect(result.error).not.toContain('ValueExpected');
        expect(result.line).toBe(2);
    });

    it('explains a missing closing brace without exposing the parser enum', () => {
        const result = parseConfigSource('settings', '{\n  "terminal.fontSize": 17');

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Expected invalid JSONC');
        expect(result.error).toContain('A closing brace } is missing');
        expect(result.error).not.toContain('CloseBraceExpected');
        expect(result.line).toBe(2);
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
        expect(result.value['terminal.scrollback']).toBe(8000);
        expect(result.value['terminal.gpuAcceleration']).toBe('on');
        expect(result.value['terminal.osc52ClipboardWrite']).toBe(true);
        expect(result.value['editor.fontFamily']).toBe(
            "'Fira Code', 'JetBrains Mono', 'Caxri JetBrains Mono', monospace",
        );
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

describe('configReducer theme import warnings', () => {
    const imported = {
        ...draculaTheme,
        id: 'imported-theme',
    };
    const warnings = [{ id: 'unsupported-syntax', message: 'Unsupported syntax scope' }];

    function importedState(): ConfigState {
        return configReducer(loadedState(), {
            type: 'theme/imported',
            value: imported,
            source: 'imported source',
            warnings,
        });
    }

    it.each([
        { type: 'theme/applied', value: imported, source: 'applied source' },
        { type: 'theme/sourceParsed', value: imported },
        { type: 'theme/reconciled', value: imported, source: 'reconciled source' },
        { type: 'theme/externalChanged', value: imported, source: 'external source' },
    ] as const)('keeps session warnings after $type replaces the serialized theme', (action) => {
        const state = configReducer(importedState(), action);
        expect(state.theme.warnings).toEqual(warnings);
    });

    it('does not attach warnings to a different theme or a new import', () => {
        const state = importedState();
        const different = configReducer(state, {
            type: 'theme/applied',
            value: { ...imported, id: 'different-theme' },
            source: 'different source',
        });
        expect(different.theme.warnings).toEqual([]);

        const reimported = configReducer(state, {
            type: 'theme/imported',
            value: imported,
            source: 'reimported source',
            warnings: [],
        });
        expect(reimported.theme.warnings).toEqual([]);
    });

    it('keeps a pending draft during reconciliation', () => {
        const current = importedState();
        const pending = configReducer(current, {
            type: 'theme/sourceChanged',
            source: 'pending source',
        });
        const reconciled = configReducer(pending, {
            type: 'theme/reconciled',
            value: imported,
            source: 'reconciled source',
        });
        expect(reconciled.theme.value).toBe(imported);
        expect(reconciled.theme.warnings).toEqual(warnings);
    });

    it('keeps the current warnings when an invalid external edit has no value', () => {
        const state = configReducer(importedState(), {
            type: 'theme/externalChanged',
            source: 'invalid source',
        });
        expect(state.theme.value).toBe(imported);
        expect(state.theme.warnings).toEqual(warnings);
    });

    it('does not attach warnings to a manual edit or a fresh load', () => {
        const changed = configReducer(importedState(), {
            type: 'theme/changed',
            value: imported,
            source: 'edited source',
        });
        expect(changed.theme.warnings).toEqual([]);

        const loaded = configReducer(importedState(), {
            type: 'loaded',
            settings: { value: {} as AppSettings, source: 'settings' },
            keybindings: { value: [], source: 'keybindings', conflicts: [] },
            theme: { value: imported, source: 'theme' },
        });
        expect(loaded.theme.warnings).toEqual([]);
    });
});

/**
 * Closing Settings with an unparsable Source draft keeps it, and the next untargeted open must land back on that file.
 */
describe('invalidSourceDraft', () => {
    it('finds no draft while every source matches what was applied', () => {
        expect(invalidSourceDraft(loadedState())).toBeUndefined();
    });

    it('ignores an edited draft that still parses, since closing commits it', () => {
        const state = configReducer(loadedState(), {
            type: 'settings/sourceChanged',
            source: SETTINGS_SOURCE,
        });

        expect(invalidSourceDraft(state)).toBeUndefined();
    });

    it('names the file whose edited draft no longer parses', () => {
        const state = configReducer(loadedState(), {
            type: 'keybindings/sourceChanged',
            source: '[{ "key": ',
        });

        expect(invalidSourceDraft(state)).toBe('keybindings');
    });
});
