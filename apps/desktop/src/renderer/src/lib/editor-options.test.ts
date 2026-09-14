import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveEditorOptions } from './editor-options';

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
});
