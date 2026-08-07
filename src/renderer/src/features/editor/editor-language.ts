export const DOTENV_LANGUAGE_ID = 'dotenv';
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

/**
 * Selects syntax for configuration files on Caxri's custom model URI. Dotenv stays explicit because
 * Monaco filename inference is not reliable while a cold editor and custom language initialize.
 */
export function resolveEditorLanguage(path: string): string | undefined {
    const filename = modelFilename(path);
    if (filename === '.env' || filename.startsWith('.env.') || filename.endsWith('.env'))
        return DOTENV_LANGUAGE_ID;
    if (ignoreFilenames.has(filename) || filename.endsWith('.ignore')) return IGNORE_LANGUAGE_ID;
    if (/^\.[^.]+rc$/.test(filename)) return RC_LANGUAGE_ID;
    return undefined;
}
