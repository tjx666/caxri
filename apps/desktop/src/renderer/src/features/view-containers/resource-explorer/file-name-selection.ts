/**
 * Where the initial selection of the inline rename field ends. A file selects its stem so typing replaces the name and
 * keeps the extension; a leading dot (`.gitignore`) is part of the name rather than an extension separator, and a
 * folder selects everything.
 */
export function renameSelectionEnd(name: string, isFile: boolean): number {
    if (!isFile) return name.length;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? dot : name.length;
}
