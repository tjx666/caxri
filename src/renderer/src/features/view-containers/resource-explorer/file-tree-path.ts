/**
 * Returns the directory whose listing directly owns an absolute path.
 */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator === -1) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}
