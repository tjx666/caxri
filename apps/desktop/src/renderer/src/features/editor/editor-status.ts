import { omit } from 'es-toolkit';

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
    'jsonc': 'JSON with Comments',
    'markdown': 'Markdown',
    'plaintext': 'Plain Text',
    'python': 'Python',
    'rc': 'Configuration',
    'rust': 'Rust',
    'shell': 'Shell Script',
    'sql': 'SQL',
    'typescript': 'TypeScript',
    'typescriptreact': 'TypeScript React',
    'xml': 'XML',
    'yaml': 'YAML',
};

export function editorLanguageLabel(languageId: string): string {
    return (
        LANGUAGE_LABELS[languageId] ??
        languageId
            .split(/[-_]/)
            .filter(Boolean)
            .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
            .join(' ')
    );
}
