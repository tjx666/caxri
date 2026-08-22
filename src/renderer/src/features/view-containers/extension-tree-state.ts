import type { ExtensionTreeViewState, TreeItemDto } from '@shared/views';
import { MAX_VIEW_TREE_HANDLES, MAX_VIEW_TREE_PERSISTED_IDS } from '@shared/views';

const STABLE_KEY_PREFIX = 'id\0';
const TRANSIENT_KEY_PREFIX = 'handle\0';

export interface ExtensionTreeState {
    expandedKeys: ReadonlySet<string>;
    initializedKeys: ReadonlySet<string>;
    focusedKey?: string;
}

export interface TreeChildrenReplacement {
    children: ReadonlyMap<string, readonly TreeItemDto[]>;
    retiredHandles: ReadonlySet<string>;
}

export type TreeRowAction = 'none' | 'toggle' | 'activate';

function treeItemStateKey(item: TreeItemDto): string {
    return item.id ? `${STABLE_KEY_PREFIX}${item.id}` : `${TRANSIENT_KEY_PREFIX}${item.handle}`;
}

function stableItemId(key: string | undefined): string | undefined {
    return key?.startsWith(STABLE_KEY_PREFIX) ? key.slice(STABLE_KEY_PREFIX.length) : undefined;
}

export function createExtensionTreeState(persisted?: ExtensionTreeViewState): ExtensionTreeState {
    return {
        expandedKeys: new Set(persisted?.expandedItemIds.map((id) => `${STABLE_KEY_PREFIX}${id}`)),
        initializedKeys: new Set(
            persisted?.initializedItemIds.map((id) => `${STABLE_KEY_PREFIX}${id}`),
        ),
        ...(persisted?.focusedItemId && {
            focusedKey: `${STABLE_KEY_PREFIX}${persisted.focusedItemId}`,
        }),
    };
}

/**
 * Applies provider-owned initial expansion exactly once per logical item. Explicit IDs survive refresh/restart;
 * handle-only fallbacks intentionally last only for the mounted Extension Host generation.
 */
export function reconcileTreeItems(
    state: ExtensionTreeState,
    items: readonly TreeItemDto[],
): ExtensionTreeState {
    let expandedKeys: Set<string> | undefined;
    let initializedKeys: Set<string> | undefined;
    for (const item of items) {
        const key = treeItemStateKey(item);
        if (state.initializedKeys.has(key) || initializedKeys?.has(key)) continue;
        initializedKeys ??= new Set(state.initializedKeys);
        if (initializedKeys.size < MAX_VIEW_TREE_HANDLES) initializedKeys.add(key);
        if (item.collapsibleState === 'expanded') {
            expandedKeys ??= new Set(state.expandedKeys);
            if (expandedKeys.size < MAX_VIEW_TREE_HANDLES) expandedKeys.add(key);
        }
    }
    if (!expandedKeys && !initializedKeys) return state;
    return {
        ...state,
        expandedKeys: expandedKeys ?? state.expandedKeys,
        initializedKeys: initializedKeys ?? state.initializedKeys,
    };
}

export function isTreeItemExpanded(state: ExtensionTreeState, item: TreeItemDto): boolean {
    return state.expandedKeys.has(treeItemStateKey(item));
}

export function isTreeItemFocused(state: ExtensionTreeState, item: TreeItemDto): boolean {
    return state.focusedKey === treeItemStateKey(item);
}

export function toggleTreeItem(state: ExtensionTreeState, item: TreeItemDto): ExtensionTreeState {
    const key = treeItemStateKey(item);
    const expandedKeys = new Set(state.expandedKeys);
    if (expandedKeys.has(key)) expandedKeys.delete(key);
    else expandedKeys.add(key);
    const initializedKeys = new Set(state.initializedKeys);
    initializedKeys.add(key);
    return { ...state, expandedKeys, initializedKeys };
}

export function focusTreeItem(state: ExtensionTreeState, item: TreeItemDto): ExtensionTreeState {
    const focusedKey = treeItemStateKey(item);
    return state.focusedKey === focusedKey ? state : { ...state, focusedKey };
}

/**
 * Replaces one provider branch and retires every cached descendant from the previous branch. Stable handles may be
 * reused by the refreshed direct children, but their old subtrees are no longer valid until the Extension Host serves
 * those children again.
 */
export function replaceTreeChildren(
    current: ReadonlyMap<string, readonly TreeItemDto[]>,
    parentHandle: string,
    items: readonly TreeItemDto[],
): TreeChildrenReplacement {
    const retiredHandles = new Set<string>();
    const collectDescendants = (handle: string): void => {
        const descendants = current.get(handle) ?? [];
        for (const descendant of descendants) {
            if (retiredHandles.has(descendant.handle)) continue;
            retiredHandles.add(descendant.handle);
            collectDescendants(descendant.handle);
        }
    };
    collectDescendants(parentHandle);

    const children = new Map(current);
    for (const handle of retiredHandles) children.delete(handle);
    children.set(parentHandle, items);
    return { children, retiredHandles };
}

export function serializeExtensionTreeState(state: ExtensionTreeState): ExtensionTreeViewState {
    const expandedItemIds = [...state.expandedKeys]
        .map(stableItemId)
        .filter((id): id is string => id !== undefined)
        .slice(0, MAX_VIEW_TREE_PERSISTED_IDS);
    const initializedItemIds = [...state.initializedKeys]
        .map(stableItemId)
        .filter((id): id is string => id !== undefined)
        .slice(0, MAX_VIEW_TREE_PERSISTED_IDS);
    const focusedItemId = stableItemId(state.focusedKey);
    return {
        expandedItemIds,
        initializedItemIds,
        ...(focusedItemId && { focusedItemId }),
    };
}

export function pointerTreeRowAction(
    item: TreeItemDto,
    event: 'click' | 'doubleClick',
    detail: number,
): TreeRowAction {
    const isCollapsible = item.collapsibleState !== 'none';
    if (event === 'click') {
        if (detail !== 1) return 'none';
        return isCollapsible ? 'toggle' : item.command ? 'activate' : 'none';
    }
    return isCollapsible && item.command ? 'activate' : 'none';
}

export function keyboardTreeRowAction(item: TreeItemDto, key: string): TreeRowAction {
    const isCollapsible = item.collapsibleState !== 'none';
    if (key === ' ') return isCollapsible ? 'toggle' : 'none';
    if (key !== 'Enter') return 'none';
    if (item.command) return 'activate';
    return isCollapsible ? 'toggle' : 'none';
}
