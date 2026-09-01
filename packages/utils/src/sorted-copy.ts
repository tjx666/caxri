/**
 * Returns a sorted copy without relying on ES2023 `Array.prototype.toSorted`, which is not available in the Hermes
 * runtime bundled with the mobile app.
 */
export function sortedCopy<T>(values: Iterable<T>, compare: (left: T, right: T) => number): T[] {
    const result: T[] = [];
    for (const value of values) result.push(value);
    result.sort(compare);
    return result;
}
