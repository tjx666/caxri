/**
 * Avoids lazy or extension-provided `dotenv` registrations replacing Caxri's tokenizer.
 */
export const DOTENV_LANGUAGE_ID = 'caxri-dotenv';
export const IGNORE_LANGUAGE_ID = 'ignore';
export const RC_LANGUAGE_ID = 'rc';
/**
 * Monaco ships no Mermaid grammar, so a `.mmd` file read as Plain Text. The id matches the one the Mermaid extensions
 * and the file-icon theme use.
 */
export const MERMAID_LANGUAGE_ID = 'mermaid';
export const MERMAID_LANGUAGE_EXTENSIONS = ['.mmd', '.mermaid'] as const;

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

export interface EditorLanguageRegistration {
    id: string;
    extensions?: readonly string[];
    filenames?: readonly string[];
}

/**
 * Selects syntax for configuration files on Caxri's custom model URI. Dotenv stays explicit because Monaco filename
 * inference is not reliable while a cold editor and custom language initialize.
 */
export function resolveEditorLanguage(path: string): string | undefined {
    const filename = modelFilename(path);
    if (filename === '.env' || filename.startsWith('.env.') || filename.endsWith('.env'))
        return DOTENV_LANGUAGE_ID;
    if (ignoreFilenames.has(filename) || filename.endsWith('.ignore')) return IGNORE_LANGUAGE_ID;
    if (/^\.[^.]+rc$/.test(filename)) return RC_LANGUAGE_ID;
    if (MERMAID_LANGUAGE_EXTENSIONS.some((extension) => filename.endsWith(extension)))
        return MERMAID_LANGUAGE_ID;
    return undefined;
}

/**
 * Resolves Monaco's built-in language registrations for wrappers that otherwise force an unknown `text` language
 * instead of inferring from the model URI. Exact filenames win, followed by the longest matching extension so compound
 * suffixes remain deterministic.
 */
export function resolveRegisteredEditorLanguage(
    path: string,
    registrations: readonly EditorLanguageRegistration[],
): string | undefined {
    const explicit = resolveEditorLanguage(path);
    if (explicit) return explicit;
    const filename = modelFilename(path);
    const filenameMatch = registrations.find((registration) =>
        registration.filenames?.some((candidate) => candidate.toLowerCase() === filename),
    );
    if (filenameMatch) return filenameMatch.id;
    let matchedLanguage: string | undefined;
    let matchedExtensionLength = -1;
    for (const registration of registrations) {
        const extensions = registration.extensions ?? [];
        for (const extension of extensions) {
            const normalizedExtension = extension.toLowerCase();
            if (
                filename.endsWith(normalizedExtension) &&
                normalizedExtension.length > matchedExtensionLength
            ) {
                matchedLanguage = registration.id;
                matchedExtensionLength = normalizedExtension.length;
            }
        }
    }
    return matchedLanguage;
}
