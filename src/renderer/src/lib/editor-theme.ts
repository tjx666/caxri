import type { ThemeTokens } from '@shared/types';

import { monaco } from './monaco';

/** Keeps every Monaco surface aligned with the active Caxri theme. */
export function applyEditorTheme(theme: ThemeTokens): void {
    monaco.editor.defineTheme('caxri-active', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: theme.editor.comment.slice(1) },
            { token: 'keyword', foreground: theme.editor.keyword.slice(1) },
            { token: 'string', foreground: theme.editor.string.slice(1) },
            { token: 'number', foreground: theme.editor.number.slice(1) },
        ],
        colors: {
            'editor.background': theme.editor.background,
            'editor.foreground': theme.editor.foreground,
            'editor.lineHighlightBackground': theme.editor.lineHighlight,
            'editor.selectionBackground': theme.editor.selection,
        },
    });
    monaco.editor.setTheme('caxri-active');
}
