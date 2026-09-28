/**
 * The row indexes a virtualized tree mounts: the visible window plus rows that must stay in the DOM wherever the list
 * is scrolled — above all the row holding the tree's single roving Tab stop. A wheel or scrollbar scroll moves the
 * window without moving that row; once it unmounted, no row carried `tabIndex=0`, so Tab skipped the whole tree until
 * the row scrolled back, and a focused row dropped focus to `<body>` (issue #1012).
 *
 * Negative (not found) and out-of-range indexes are ignored. Returned ascending so DOM order keeps matching tree order.
 */
export function virtualTreeRenderedIndexes(
    visibleIndexes: readonly number[],
    count: number,
    retainedIndexes: readonly number[],
): number[] {
    const indexes = new Set(visibleIndexes);
    for (const index of retainedIndexes) if (index >= 0 && index < count) indexes.add(index);
    return [...indexes].toSorted((left, right) => left - right);
}
