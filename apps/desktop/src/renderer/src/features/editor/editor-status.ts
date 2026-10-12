import { omit } from 'es-toolkit';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { createStore } from '../../lib/store';

export interface EditorStatus {
    line: number;
    column: number;
    /**
     * First and last line of the current selection (1-based, inclusive); both equal `line` for a collapsed cursor. A
     * selection that ends at column 1 of a later line excludes that line, matching how editors display line ranges.
     */
    selectionStartLine: number;
    selectionEndLine: number;
    selectedCharacters: number;
    languageId: string;
}

interface EditorStatusState {
    statuses: Record<string, EditorStatus | undefined>;
    setStatus(key: string, status: EditorStatus): void;
    clearStatus(key: string): void;
}

export function editorStatusKey(sessionId: string, path: string): string {
    return `${sessionId}:${path}`;
}

/**
 * Last line a selection actually covers. A selection that ends at column 1 of a later line stops short of that line, so
 * reporting the raw end line would claim one line more than the user selected. Shared so the file editor's status bar
 * and the diff editor's file reference describe the same span the same way.
 */
export function editorSelectionEndLine(
    start: { lineNumber: number },
    end: { column: number; lineNumber: number },
): number {
    return end.lineNumber > start.lineNumber && end.column === 1
        ? end.lineNumber - 1
        : end.lineNumber;
}

export const useEditorStatusStore = createStore<EditorStatusState>('editor-status', (set) => ({
    statuses: {},
    setStatus(key, status) {
        set((state) => ({ statuses: { ...state.statuses, [key]: status } }));
    },
    clearStatus(key) {
        set((state) => {
            if (!Object.hasOwn(state.statuses, key)) return state;
            return { statuses: omit(state.statuses, [key]) };
        });
    },
}));

/**
 * Language names that are ordinary words rather than product or format names, so they are translated.
 */
const TRANSLATED_LANGUAGE_LABELS: Readonly<Record<string, TranslationKey>> = {
    jsonc: 'editor.language.jsonc',
    plaintext: 'editor.language.plaintext',
    rc: 'editor.language.rc',
    shell: 'editor.language.shell',
};

const LANGUAGE_LABELS: Record<string, string> = {
    'caxri-dotenv': 'Dotenv',
    'css': 'CSS',
    'dockerfile': 'Dockerfile',
    'go': 'Go',
    'html': 'HTML',
    'ignore': 'Ignore',
    'ini': 'INI',
    'javascript': 'JavaScript',
    'javascriptreact': 'JavaScript React',
    'json': 'JSON',
    'markdown': 'Markdown',
    'python': 'Python',
    'rust': 'Rust',
    'sql': 'SQL',
    'typescript': 'TypeScript',
    'typescriptreact': 'TypeScript React',
    'xml': 'XML',
    'yaml': 'YAML',
};

/**
 * `t` defaults to `translate()` for callers outside React; a component passes its `useTranslation()` `t` so the label
 * follows a language change.
 */
export function editorLanguageLabel(languageId: string, t: Translate = translate): string {
    const translatedKey = Object.hasOwn(TRANSLATED_LANGUAGE_LABELS, languageId)
        ? TRANSLATED_LANGUAGE_LABELS[languageId]
        : undefined;
    if (translatedKey) return t(translatedKey);
    return (
        LANGUAGE_LABELS[languageId] ??
        languageId
            .split(/[-_]/)
            .filter(Boolean)
            .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
            .join(' ')
    );
}
