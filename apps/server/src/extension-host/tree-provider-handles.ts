import type { DisposableLike, TreeDataProvider } from 'caxri';

/**
 * A registered tree provider and the handle bookkeeping that maps its elements to the stable handles the Workbench
 * holds.
 */
export interface ProviderRegistration {
    extensionId: string;
    generation: number;
    provider: TreeDataProvider<unknown>;
    subscription?: DisposableLike;
    elements: Map<string, unknown>;
    handles: WeakMap<object, string>;
    depths: Map<string, number>;
    children: Map<string, Set<string>>;
    parents: Map<string, string>;
    ids: Map<string, string>;
    itemIds: Map<string, string>;
    nextHandle: number;
    refreshEpoch: number;
}

export function stableTreeHandle(id: string): string {
    return `id:${id}`;
}

export function collectDescendantHandles(
    provider: ProviderRegistration,
    parentHandle: string,
): Set<string> {
    const descendants = new Set<string>();
    const visit = (parent: string): void => {
        const childHandles = provider.children.get(parent) ?? [];
        for (const child of childHandles) {
            if (descendants.has(child)) continue;
            descendants.add(child);
            visit(child);
        }
    };
    visit(parentHandle);
    return descendants;
}

export function retireTreeHandles(
    provider: ProviderRegistration,
    handles: ReadonlySet<string>,
): void {
    for (const handle of handles) {
        const element = provider.elements.get(handle);
        if (typeof element === 'object' && element !== null) provider.handles.delete(element);
        const id = provider.itemIds.get(handle);
        if (id && provider.ids.get(id) === handle) provider.ids.delete(id);
        provider.elements.delete(handle);
        provider.depths.delete(handle);
        provider.parents.delete(handle);
        provider.itemIds.delete(handle);
        provider.children.delete(handle);
    }
}
