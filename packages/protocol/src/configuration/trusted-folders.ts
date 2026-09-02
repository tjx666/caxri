export const MAX_TRUSTED_FOLDERS = 128;
export const MAX_TRUSTED_FOLDER_LENGTH = 4_096;

/**
 * Canonicalizes one persisted Trusted Folder rule: an absolute POSIX directory path without `.` segments, repeated
 * separators, or a trailing slash. `~`, shell variables, `..` segments, and the filesystem root are rejected so a rule
 * can never silently widen past the folder the user actually confirmed. Implemented without `node:path` because this
 * module is shared with the sandboxed Renderer.
 */
export function normalizeTrustedFolderRule(input: string): string | undefined {
    const value = input.trim();
    if (!value || value.length > MAX_TRUSTED_FOLDER_LENGTH || value.includes('\0')) return;
    if (!value.startsWith('/')) return;
    const segments = value.split('/').filter((segment) => segment && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) return;
    return `/${segments.join('/')}`;
}

/**
 * Whether an absolute path sits at or beneath any bounded, independently normalized Trusted Folder rule.
 */
export function isPathInTrustedFolder(path: string, rules: readonly string[]): boolean {
    const target = normalizeTrustedFolderRule(path);
    if (!target) return false;
    for (const input of rules.slice(0, MAX_TRUSTED_FOLDERS)) {
        const rule = normalizeTrustedFolderRule(input);
        if (!rule) continue;
        if (target === rule || target.startsWith(`${rule}/`)) return true;
    }
    return false;
}
