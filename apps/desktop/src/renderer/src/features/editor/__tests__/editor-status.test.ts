import { beforeEach, describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import type { EditorStatus } from '../editor-status';
import { editorLanguageLabel, editorStatusKey, useEditorStatusStore } from '../editor-status';

function status(overrides: Partial<EditorStatus> = {}): EditorStatus {
    return {
        line: 1,
        column: 1,
        selectionStartLine: overrides.line ?? 1,
        selectionEndLine: overrides.line ?? 1,
        selectedCharacters: 0,
        languageId: 'typescript',
        ...overrides,
    };
}

describe('editorStatusKey', () => {
    it('composes a stable Session-and-path key', () => {
        expect(editorStatusKey('session-1', '/src/index.ts')).toBe('session-1:/src/index.ts');
    });

    it('keeps distinct Sessions viewing the same path from colliding', () => {
        expect(editorStatusKey('session-1', '/src/index.ts')).not.toBe(
            editorStatusKey('session-2', '/src/index.ts'),
        );
    });
});

describe('editorLanguageLabel', () => {
    it('returns the curated label for a known language id', () => {
        expect(editorLanguageLabel('typescriptreact', translate)).toBe('TypeScript React');
        expect(editorLanguageLabel('json', translate)).toBe('JSON');
    });

    it('falls back to Title Case for an unknown kebab-case language id', () => {
        expect(editorLanguageLabel('my-custom-lang', translate)).toBe('My Custom Lang');
    });

    it('falls back to Title Case for an unknown snake_case language id', () => {
        expect(editorLanguageLabel('my_custom_lang', translate)).toBe('My Custom Lang');
    });

    it('title-cases a single unknown word', () => {
        expect(editorLanguageLabel('zig', translate)).toBe('Zig');
    });
});

describe('editor status store', () => {
    beforeEach(() => {
        useEditorStatusStore.setState({ statuses: {} });
    });

    it('sets and reads a status by key', () => {
        useEditorStatusStore.getState().setStatus('session-1:/a.ts', status({ line: 5 }));

        expect(useEditorStatusStore.getState().statuses['session-1:/a.ts']).toEqual(
            status({ line: 5 }),
        );
    });

    it('overwrites an existing status for the same key', () => {
        useEditorStatusStore.getState().setStatus('session-1:/a.ts', status({ line: 5 }));
        useEditorStatusStore.getState().setStatus('session-1:/a.ts', status({ line: 9 }));

        expect(useEditorStatusStore.getState().statuses['session-1:/a.ts']).toEqual(
            status({ line: 9 }),
        );
    });

    it('clears a status by key', () => {
        useEditorStatusStore.getState().setStatus('session-1:/a.ts', status());

        useEditorStatusStore.getState().clearStatus('session-1:/a.ts');

        expect(useEditorStatusStore.getState().statuses['session-1:/a.ts']).toBeUndefined();
    });

    it('is a no-op to clear a key that was never set', () => {
        const before = useEditorStatusStore.getState().statuses;

        useEditorStatusStore.getState().clearStatus('never-set');

        // No matching own key means the store must return the same object reference instead of a
        // new one, so unrelated subscribers do not re-render.
        expect(useEditorStatusStore.getState().statuses).toBe(before);
    });

    it('leaves other keys untouched when clearing one', () => {
        useEditorStatusStore.getState().setStatus('session-1:/a.ts', status());
        useEditorStatusStore.getState().setStatus('session-2:/b.ts', status({ line: 2 }));

        useEditorStatusStore.getState().clearStatus('session-1:/a.ts');

        expect(useEditorStatusStore.getState().statuses['session-2:/b.ts']).toEqual(
            status({ line: 2 }),
        );
    });
});
