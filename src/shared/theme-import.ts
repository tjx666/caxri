/**
 * Declarative registry of theme import formats shared by the Runtime (which parses the file
 * content) and Main (which builds the file-picker dialog filters). Keeping a single source of
 * truth here avoids the extension list drifting between the two processes.
 *
 * Each `id` must stay within the `source` z.enum on `themeTokensSchema`
 * (src/shared/ipc/domain.ts) — that enum is `['builtin', 'custom', 'vscode', 'iterm2', 'warp']`,
 * and every format id below (`iterm2`, `warp`, `vscode`) is one of its values.
 */
export const themeImportFormats = [
    {
        id: 'iterm2',
        extensions: ['itermcolors'],
        /**
        iTerm2 is terminal-only; app and editor colors inherit from the active theme.
         */
        terminalOnly: true,
    },
    {
        id: 'warp',
        extensions: ['yaml', 'yml'],
        /**
        Warp is terminal-only; app and editor colors inherit from the active theme.
         */
        terminalOnly: true,
    },
    {
        id: 'vscode',
        extensions: ['json', 'jsonc'],
        terminalOnly: false,
    },
] as const;

/**
Flat, de-duplicated list of every extension across `themeImportFormats`, for dialog filters.
 */
export const themeImportExtensions = themeImportFormats.flatMap((format) => format.extensions);
