import type { AppSettings, ThemeTokens } from '@shared/types';
import { describe, expect, it } from 'vitest';

import type { ConfigState } from '../settings-drafts';
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
});
