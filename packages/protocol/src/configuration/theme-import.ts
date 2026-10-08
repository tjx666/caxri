import type { ThemeImportFormatId } from '../domain/domain.js';
import { themeImportFormatIds } from '../domain/domain.js';

interface ThemeImportFormatDefinition {
    extensions: readonly string[];
    /**
     * Terminal-only imports keep the current app and editor colors from the active theme.
     */
    terminalOnly: boolean;
}

/**
 * Declarative registry of theme import formats shared by the Runtime (which parses the file content) and Main (which
 * builds the file-picker dialog filters). Ids are the import-format subset of `themeTokenSourceIds`: adding a format
 * fails typecheck until protocol persistence and this record both name it.
 */
const themeImportFormatsById = {
    iterm2: {
        extensions: ['itermcolors'],
        terminalOnly: true,
    },
    warp: {
        extensions: ['yaml', 'yml'],
        terminalOnly: true,
    },
    vscode: {
        extensions: ['json', 'jsonc'],
        terminalOnly: false,
    },
} as const satisfies Record<ThemeImportFormatId, ThemeImportFormatDefinition>;

export const themeImportFormats = themeImportFormatIds.map((id) => ({
    id,
    ...themeImportFormatsById[id],
}));

/**
 * Flat, de-duplicated list of every extension across `themeImportFormats`, for dialog filters.
 */
export const themeImportExtensions = themeImportFormats.flatMap((format) => format.extensions);
