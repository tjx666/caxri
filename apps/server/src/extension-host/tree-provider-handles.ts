import type { DisposableLike, TreeDataProvider } from 'caxri';

import type { ExtensionViewEventScope } from './protocol';

/**
 * Handle bookkeeping for one request scope of a tree provider: the map from its elements to the stable handles the
 * Workbench holds. Two windows or a phone can read the same view for different Sessions at once, so every scope owns
 * its own handles and refresh epoch; a handle minted for one Session never resolves in another.
 */
export interface TreeScopeState {
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

/**
 * A registered tree provider and its per-scope handle bookkeeping.
 */
export interface ProviderRegistration {
    extensionId: string;
    generation: number;
    provider: TreeDataProvider<unknown>;
    subscription?: DisposableLike;
    scopes: Map<string, TreeScopeState>;
}

/**
 * Bounds the scopes one view keeps handles for. Each viewed Session adds one; the least recently read scope is dropped
 * first, and a later expansion there fails as an expired handle, which the Workbench recovers by re-reading the root.
 */
const MAX_TREE_SCOPES_PER_VIEW = 64;

export function treeScopeKey(context: ExtensionViewEventScope | undefined): string {
    return context?.kind === 'session'
        ? `${context.sessionId}:${context.workbenchProjectId}`
        : 'no-session';
}

function emptyTreeScope(): TreeScopeState {
    return {
        elements: new Map(),
        handles: new WeakMap(),
        depths: new Map(),
        children: new Map(),
        parents: new Map(),
        ids: new Map(),
        itemIds: new Map(),
        nextHandle: 0,
        refreshEpoch: 0,
    };
}

/**
 * The scope's state, created on first use and marked most recently used.
 */
export function treeScopeFor(provider: ProviderRegistration, scopeKey: string): TreeScopeState {
    const existing = provider.scopes.get(scopeKey);
    const state = existing ?? emptyTreeScope();
    provider.scopes.delete(scopeKey);
    provider.scopes.set(scopeKey, state);
    if (!existing && provider.scopes.size > MAX_TREE_SCOPES_PER_VIEW) {
        const oldest = provider.scopes.keys().next().value;
        if (oldest !== undefined) {
            resetTreeScope(provider.scopes.get(oldest)!);
            provider.scopes.delete(oldest);
        }
    }
    return state;
}

/**
 * Retires every handle in place and advances the refresh epoch, so a read still running against this scope fails as
 * expired instead of publishing handles into the cleared maps.
 */
export function resetTreeScope(state: TreeScopeState): void {
    state.refreshEpoch += 1;
    state.elements.clear();
    state.depths.clear();
    state.children.clear();
    state.parents.clear();
    state.ids.clear();
    state.itemIds.clear();
    state.handles = new WeakMap();
    state.nextHandle = 0;
}

export function stableTreeHandle(id: string): string {
    return `id:${id}`;
}

export function collectDescendantHandles(state: TreeScopeState, parentHandle: string): Set<string> {
    const descendants = new Set<string>();
    const visit = (parent: string): void => {
        const childHandles = state.children.get(parent) ?? [];
        for (const child of childHandles) {
            if (descendants.has(child)) continue;
            descendants.add(child);
            visit(child);
        }
    };
    visit(parentHandle);
    return descendants;
}

export function retireTreeHandles(state: TreeScopeState, handles: ReadonlySet<string>): void {
    for (const handle of handles) {
        const element = state.elements.get(handle);
        if (typeof element === 'object' && element !== null) state.handles.delete(element);
        const id = state.itemIds.get(handle);
        if (id && state.ids.get(id) === handle) state.ids.delete(id);
        state.elements.delete(handle);
        state.depths.delete(handle);
        state.parents.delete(handle);
        state.itemIds.delete(handle);
        state.children.delete(handle);
    }
}
