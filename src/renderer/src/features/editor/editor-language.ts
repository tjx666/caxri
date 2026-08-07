export const IGNORE_LANGUAGE_ID = 'ignore';
export const RC_LANGUAGE_ID = 'rc';

export const IGNORE_LANGUAGE_FILENAMES = [
    '.dockerignore',
    '.eslintignore',
    '.gitignore',
    '.helmignore',
    '.npmignore',
    '.prettierignore',
    '.stylelintignore',
    '.vercelignore',
] as const;

const ignoreFilenames = new Set<string>(IGNORE_LANGUAGE_FILENAMES);

function modelFilename(path: string): string {
    const encoded = path.split('/').at(-1) ?? '';
    try {
        return decodeURIComponent(encoded).toLowerCase();
    } catch {
        return encoded.toLowerCase();
    }
}

/** Selects syntax only for configuration filenames Monaco cannot infer from the model URI. */
export function resolveEditorLanguage(path: string): string | undefined {
    const filename = modelFilename(path);
    if (ignoreFilenames.has(filename) || filename.endsWith('.ignore')) return IGNORE_LANGUAGE_ID;
    if (/^\.[^.]+rc$/.test(filename)) return RC_LANGUAGE_ID;
    return undefined;
}
