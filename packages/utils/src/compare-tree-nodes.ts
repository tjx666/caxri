/**
 * Orders tree nodes with directories before files, then alphabetically by `name` within each group.
 *
 * Uses `String.prototype.localeCompare` deliberately: es-toolkit's `sortBy` is not locale-aware, and a plain `<`/`>`
 * comparison mis-orders accented and non-ASCII names. This comparator is the shared, locale-correct replacement.
 */
export function compareTreeNodesDirectoriesFirst<
    T extends { kind: 'directory' | 'file'; name: string },
>(left: T, right: T): number {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
}
