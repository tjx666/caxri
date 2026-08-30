/**
 * Collects one already-known tree subtree in depth-first order. The visited set makes provider-owned cycles harmless;
 * callers decide what "known" means by returning only children already present in their local tree model.
 */
export function collectTreeSubtree<T>(root: T, childrenOf: (node: T) => Iterable<T>): T[] {
    const collected: T[] = [];
    const visited = new Set<T>();
    const visit = (node: T): void => {
        if (visited.has(node)) return;
        visited.add(node);
        collected.push(node);
        for (const child of childrenOf(node)) visit(child);
    };
    visit(root);
    return collected;
}
