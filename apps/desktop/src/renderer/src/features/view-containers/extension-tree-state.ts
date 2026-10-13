import type { ExtensionTreeViewState, TreeItemDto } from '@caxri/protocol';
import { MAX_VIEW_TREE_HANDLES, MAX_VIEW_TREE_PERSISTED_IDS } from '@caxri/protocol';
import { collectTreeSubtree } from '@caxri/utils';

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

export type TreeRowAction = 'none' | 'toggle' | 'toggle-recursive' | 'activate';

/**
 * Existing healthy branches refresh silently; first expansion and error retries retain loading feedback.
 */
export function treeSnapshotLoading(
    loading: ReadonlySet<string>,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
): ReadonlySet<string> {
    return new Set(
        loading.values().filter((handle) => !children.has(handle) || errors.has(handle)),
    );
}

/**
 * The tree a view keeps on screen while its working tree rebuilds.
 */
export interface TreeSnapshot {
    children: ReadonlyMap<string, readonly TreeItemDto[]>;
    errors: ReadonlyMap<string, string>;
    /**
     * Branches still loading when a first-load snapshot was taken, so their placeholders stay drawn; empty once
     * complete.
     */
    loading: ReadonlySet<string>;
    /**
     * Whether every visible branch had settled. Until the first complete tree, the snapshot follows the partial tree on
     * screen instead.
     */
    isComplete: boolean;
}

const NO_LOADING: ReadonlySet<string> = new Set();

export function completeTreeSnapshot(
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
): TreeSnapshot {
    return { children, errors, loading: NO_LOADING, isComplete: true };
}

/**
 * Advances the on-screen snapshot, returning `current` itself when nothing changed. A settled tree replaces it. Before
 * the first settled tree, it follows whatever partial tree has its root loaded, so a provider reset mid-load (Status
 * pushes a whole-tree change as each source answers) keeps the rows already shown instead of falling back to the root
 * skeleton. A complete snapshot is never replaced by a partial one.
 */
export function nextTreeSnapshot(
    current: TreeSnapshot | undefined,
    rootHandle: string,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
    loading: ReadonlySet<string>,
    isReady: boolean,
): TreeSnapshot | undefined {
    if (isReady)
        return current?.isComplete && current.children === children && current.errors === errors
            ? current
            : completeTreeSnapshot(children, errors);
    if (current?.isComplete || !children.has(rootHandle)) return current;
    if (current?.children === children && current.errors === errors && current.loading === loading)
        return current;
    return { children, errors, loading, isComplete: false };
}

/**
 * The branches that draw a loading placeholder over `snapshot`: the live loads plus those a first-load snapshot was
 * waiting on, minus any branch the snapshot can already answer.
 */
export function visibleTreeLoading(
    loading: ReadonlySet<string>,
    snapshot: TreeSnapshot | undefined,
): ReadonlySet<string> {
    if (!snapshot) return loading;
    const pending =
        snapshot.loading.size === 0 ? loading : new Set([...loading, ...snapshot.loading]);
    return treeSnapshotLoading(pending, snapshot.children, snapshot.errors);
}

/**
 * A refresh is publishable only after every visible branch has settled, including lazy descendants.
 */
export function isTreeSnapshotReady(
    rootHandle: string,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
    loading: ReadonlySet<string>,
    state: ExtensionTreeState,
): boolean {
    const visited = new Set<string>();
    const isReady = (handle: string): boolean => {
        if (visited.has(handle)) return true;
        visited.add(handle);
        if (loading.has(handle)) return false;
        if (errors.has(handle)) return true;
        const items = children.get(handle);
        if (!items) return false;
        return items.every(
            (item) =>
                item.collapsibleState === 'none' ||
                !isTreeItemExpanded(state, item) ||
                isReady(item.handle),
        );
    };
    return isReady(rootHandle);
}

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
    return setTreeItemsExpanded(state, [item], !isTreeItemExpanded(state, item));
}

function setTreeItemsExpanded(
    state: ExtensionTreeState,
    items: readonly TreeItemDto[],
    isExpanded: boolean,
): ExtensionTreeState {
    const expandedKeys = new Set(state.expandedKeys);
    const initializedKeys = new Set(state.initializedKeys);
    /**
     * Touched items become the newest persistence candidates. Recursive batches are root-first, so reversing them
     * leaves the clicked root and its nearest descendants highest priority.
     */
    for (const item of items.toReversed()) {
        const key = treeItemStateKey(item);
        expandedKeys.delete(key);
        if (isExpanded) expandedKeys.add(key);
        initializedKeys.delete(key);
        initializedKeys.add(key);
    }
    return { ...state, expandedKeys, initializedKeys };
}

export function treeItemSubtreeHandles(
    item: TreeItemDto,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
): string[] {
    return collectTreeSubtree(item.handle, (handle) =>
        (children.get(handle) ?? []).flatMap((child) =>
            child.collapsibleState === 'none' ? [] : [child.handle],
        ),
    );
}

/**
 * Applies one target state to the selected item and every collapsible descendant already loaded into the tree model.
 * Unknown descendants stay lazy, matching VS Code's asynchronous-tree behavior.
 */
export function toggleTreeItemSubtree(
    state: ExtensionTreeState,
    item: TreeItemDto,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
): ExtensionTreeState {
    const itemsByHandle = new Map<string, TreeItemDto>();
    for (const items of children.values())
        for (const child of items)
            if (child.collapsibleState !== 'none') itemsByHandle.set(child.handle, child);
    itemsByHandle.set(item.handle, item);
    const items = treeItemSubtreeHandles(item, children)
        .map((handle) => itemsByHandle.get(handle))
        .filter((candidate): candidate is TreeItemDto => candidate !== undefined);
    const isExpanded = !isTreeItemExpanded(state, item);
    return setTreeItemsExpanded(
        state,
        isExpanded
            ? items.filter(
                  (candidate) => candidate.handle === item.handle || children.has(candidate.handle),
              )
            : items,
        isExpanded,
    );
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
        .slice(-MAX_VIEW_TREE_PERSISTED_IDS);
    const initializedItemIds = [...state.initializedKeys]
        .map(stableItemId)
        .filter((id): id is string => id !== undefined)
        .slice(-MAX_VIEW_TREE_PERSISTED_IDS);
    const focusedItemId = stableItemId(state.focusedKey);
    return {
        expandedItemIds,
        initializedItemIds,
        ...(focusedItemId && { focusedItemId }),
    };
}

/**
 * Separates the disclosure hit area from the treeitem body. Chromium emits click/detail 1, click/detail 2, then
 * doubleClick for a double click, so accepting only the first click also keeps one gesture from dispatching a command
 * twice.
 */
export function pointerTreeRowAction(
    item: TreeItemDto,
    target: 'body' | 'disclosure',
    event: 'click' | 'doubleClick',
    detail: number,
    isRecursive = false,
): TreeRowAction {
    if (event !== 'click' || detail !== 1) return 'none';
    const isCollapsible = item.collapsibleState !== 'none';
    if (target === 'disclosure')
        return isCollapsible ? (isRecursive ? 'toggle-recursive' : 'toggle') : 'none';
    /**
     * Recursive disclosure outranks the row's command: on a row that both opens a page and has children, the whole row
     * (not only its chevron) owes Option-click the same recursive toggle every other collapsible row gives (issue
     * #1126), and the command keeps the plain click it already had.
     */
    if (isCollapsible && isRecursive) return 'toggle-recursive';
    if (item.command) return 'activate';
    return isCollapsible ? 'toggle' : 'none';
}

export function keyboardTreeRowAction(item: TreeItemDto, key: string): TreeRowAction {
    const isCollapsible = item.collapsibleState !== 'none';
    if (key === ' ') return isCollapsible ? 'toggle' : 'none';
    if (key !== 'Enter') return 'none';
    if (item.command) return 'activate';
    return isCollapsible ? 'toggle' : 'none';
}
