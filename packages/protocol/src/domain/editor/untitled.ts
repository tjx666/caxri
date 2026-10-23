const UNTITLED_EDITOR_TAB_PREFIX = 'caxri-untitled://';

/**
 * Upper bound on the number in `Untitled-N`. Indexes are reused from the lowest free one, so a real Session never comes
 * near it; the bound only rejects a malformed path.
 */
const MAX_UNTITLED_INDEX = 100_000;

/**
 * Names a buffer that has never been saved, as VS Code's `Untitled-N` editors do. The index is the whole identity: the
 * buffer's content lives only in the Renderer's document cache and its on-device backup, never in Session state.
 */
export function untitledEditorTabPath(index: number): string {
    return `${UNTITLED_EDITOR_TAB_PREFIX}${index}`;
}

/**
 * The `N` of an `Untitled-N` tab path, or `undefined` for any other path.
 */
export function parseUntitledEditorTab(path: string): number | undefined {
    if (!path.startsWith(UNTITLED_EDITOR_TAB_PREFIX)) return undefined;
    const encoded = path.slice(UNTITLED_EDITOR_TAB_PREFIX.length);
    if (!/^[1-9]\d*$/.test(encoded)) return undefined;
    const index = Number(encoded);
    return index <= MAX_UNTITLED_INDEX ? index : undefined;
}

export function isUntitledEditorTabPath(path: string): boolean {
    return parseUntitledEditorTab(path) !== undefined;
}
