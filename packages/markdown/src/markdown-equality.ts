/**
 * Structural equality for the plain, JSON-shaped trees `parseMarkdownBlocks` produces. A streaming reply re-parses on
 * every delta into fresh objects; comparing by value lets a renderer skip every block the delta did not touch.
 */
export function isSameMarkdownTree(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
        return false;
    if (Array.isArray(left)) {
        if (!Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => isSameMarkdownTree(value, right[index]));
    }
    if (Array.isArray(right)) return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    return keys.every(
        (key) =>
            Object.hasOwn(rightRecord, key) &&
            isSameMarkdownTree(leftRecord[key], rightRecord[key]),
    );
}
