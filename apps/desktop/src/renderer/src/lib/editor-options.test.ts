import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { EDITOR_OPTION_KEYS, languageEditorOptions, resolveEditorOptions } from './editor-options';

describe('resolveEditorOptions', () => {
    it('falls back to the shipped defaults before settings load', () => {
        expect(resolveEditorOptions(undefined)).toEqual(resolveEditorOptions(defaultAppSettings));
        expect(resolveEditorOptions(undefined)).toMatchObject({
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            unfoldOnClickAfterEndOfLine: true,
            fontFamily: defaultAppSettings['editor.fontFamily'],
        });
    });

    /**
     * The behavior VS Code ships on and a standalone Monaco leaves off. Asserted as defaults rather than as hardcoded
     * options because each one is a setting: the point is which side of the switch a new install starts on.
     */
    it('starts with the VS Code-validated behavior turned on', () => {
        expect(resolveEditorOptions(undefined)).toMatchObject({
            autoClosingDelete: 'always',
            bracketPairColorization: { enabled: true },
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            guides: { bracketPairs: 'active' },
            linkedEditing: true,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            stickyScroll: { enabled: true },
            stickyTabStops: true,
        });
    });

    /**
     * `useEditorOptions` watches exactly this list instead of the whole settings object, so a key that this module
     * reads but the list omits would stop reaching an open editor until something else forced a repaint.
     */
    it('lists every settings key it reads', () => {
        const before = resolveEditorOptions(defaultAppSettings);
        for (const key of EDITOR_OPTION_KEYS)
            expect(Object.keys(defaultAppSettings)).toContain(key);
        expect(new Set(EDITOR_OPTION_KEYS).size).toBe(EDITOR_OPTION_KEYS.length);
        expect(before).toEqual(resolveEditorOptions(defaultAppSettings));
    });

    it('omits fontFamily when the setting is unset so Monaco keeps its own default', () => {
        const options = resolveEditorOptions({
            ...defaultAppSettings,
            'editor.fontFamily': null,
        });
        expect(options).not.toHaveProperty('fontFamily');
    });

    it('quotes a bare font name containing spaces', () => {
        expect(
            resolveEditorOptions({ ...defaultAppSettings, 'editor.fontFamily': 'Fira Code' }),
        ).toMatchObject({ fontFamily: '"Fira Code"' });
    });

    it('forwards the unfold-on-click setting', () => {
        expect(
            resolveEditorOptions({
                ...defaultAppSettings,
                'editor.unfoldOnClickAfterEndOfLine': false,
            }),
        ).toMatchObject({ unfoldOnClickAfterEndOfLine: false });
    });

    /**
     * Monaco spells the guides option `true | false | 'active'`, which is not a shape a settings file should have to
     * know, so the three-way enum is mapped on the way out.
     */
    it.each([
        ['off', false],
        ['active', 'active'],
        ['all', true],
    ] as const)('maps the %s bracket pair guides setting to %s', (setting, expected) => {
        expect(
            resolveEditorOptions({ ...defaultAppSettings, 'editor.guides.bracketPairs': setting }),
        ).toMatchObject({ guides: { bracketPairs: expected } });
    });

    it('forwards the remaining switches verbatim', () => {
        expect(
            resolveEditorOptions({
                ...defaultAppSettings,
                'editor.autoClosingDelete': 'never',
                'editor.dragAndDrop': true,
                'editor.fontSize': 20,
                'editor.minimap.enabled': true,
                'editor.wordWrap': 'bounded',
            }),
        ).toMatchObject({
            autoClosingDelete: 'never',
            dragAndDrop: true,
            fontSize: 20,
            minimap: { enabled: true },
            wordWrap: 'bounded',
        });
    });
});

describe('languageEditorOptions', () => {
    it('turns Unicode highlighting off for prose, as VS Code does for Markdown and plain text', () => {
        const prose = {
            unicodeHighlight: {
                ambiguousCharacters: false,
                includeStrings: true,
                invisibleCharacters: false,
            },
        };
        expect(languageEditorOptions('markdown')).toEqual(prose);
        expect(languageEditorOptions('plaintext')).toEqual(prose);
        expect(languageEditorOptions(undefined)).toEqual(prose);
    });

    it('restates Monaco defaults for code, so an editor switching from Markdown turns them back on', () => {
        expect(languageEditorOptions('typescript')).toEqual({
            unicodeHighlight: {
                ambiguousCharacters: true,
                includeStrings: true,
                invisibleCharacters: true,
            },
        });
    });
});
