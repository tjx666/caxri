/**
 * The `aria-keyshortcuts` a Session row announces: `Shift+Enter` (Rename with AI) while the Session can be asked for a
 * name, and `Alt+ArrowUp Alt+ArrowDown` only on a row that can move. A nested Session (one under its host) has no
 * reorder, and a row being renamed announces nothing because its input owns the keys.
 */
export function sessionRowKeyShortcuts({
    canReorder,
    canSuggest,
    renaming,
}: {
    canReorder: boolean;
    canSuggest: boolean;
    renaming: boolean;
}): string | undefined {
    if (renaming) return undefined;
    const shortcuts = [
        canSuggest && 'Shift+Enter',
        canReorder && 'Alt+ArrowUp Alt+ArrowDown',
    ].filter(Boolean);
    return shortcuts.length === 0 ? undefined : shortcuts.join(' ');
}
