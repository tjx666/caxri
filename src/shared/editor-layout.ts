import { MAX_EDITOR_LAYOUT_GROUPS } from '../../packages/protocol/src/domain/editor-layout';
import type { WorkItem } from '../../packages/protocol/src/domain/work-item';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './ipc/layout';
import type { EditorGroupNode, EditorLayout, EditorLayoutNode, EditorSplitNode } from './types';
import { isVirtualEditorTabPath } from './virtual-tabs';

export type LayoutIdFactory = () => string;

const createId: LayoutIdFactory = () => crypto.randomUUID();

/**
 * Matches one file or every descendant using Caxri's canonical absolute POSIX-style paths. Duplicated from
 * `src/renderer/src/lib/file-path.ts` rather than shared, because that module lives under the Renderer-only source tree
 * while this one must stay importable from Runtime and Main; both stay pure string logic so the duplication cost is
 * small.
 */
function isPathAtOrBelow(path: string, parent: string): boolean {
    return path === parent || path.startsWith(`${parent}/`);
}

function remapPath(path: string, previousPath: string, nextPath: string): string {
    return isPathAtOrBelow(path, previousPath)
        ? `${nextPath}${path.slice(previousPath.length)}`
        : path;
}

function group(path: string, id: LayoutIdFactory): EditorGroupNode {
    return { type: 'group', id: id(), paths: [path], activePath: path };
}

function firstGroup(node?: EditorLayoutNode): EditorGroupNode | undefined {
    if (!node) return undefined;
    return node.type === 'group' ? node : (firstGroup(node.first) ?? firstGroup(node.second));
}

function findGroup(
    node: EditorLayoutNode | undefined,
    groupId: string,
): EditorGroupNode | undefined {
    if (!node) return undefined;
    if (node.type === 'group') return node.id === groupId ? node : undefined;
    return findGroup(node.first, groupId) ?? findGroup(node.second, groupId);
}

/**
 * Unlike a Terminal (attached to exactly one group), the same `path` may legitimately live in several groups at once,
 * so this returns only the first match found by tree order — used purely as a stable "some group has it" default, never
 * as proof of a unique owner.
 */
function findFirstPathGroup(
    node: EditorLayoutNode | undefined,
    path: string,
): EditorGroupNode | undefined {
    if (!node) return undefined;
    if (node.type === 'group') return node.paths.includes(path) ? node : undefined;
    return findFirstPathGroup(node.first, path) ?? findFirstPathGroup(node.second, path);
}

function replaceNode(
    node: EditorLayoutNode,
    nodeId: string,
    replacement: (node: EditorLayoutNode) => EditorLayoutNode,
): EditorLayoutNode {
    if (node.id === nodeId) return replacement(node);
    if (node.type === 'group') return node;
    const first = replaceNode(node.first, nodeId, replacement);
    const second = replaceNode(node.second, nodeId, replacement);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Removes `path` from every group that lists it (not just the first), since editor paths are not globally unique. A
 * group emptied by the removal collapses out of the tree, mirroring `removeFromNode` in `terminal-layout.ts`.
 */
function removeFromAllGroups(node: EditorLayoutNode, path: string): EditorLayoutNode | undefined {
    if (node.type === 'group') {
        if (!node.paths.includes(path)) return node;
        const paths = node.paths.filter((candidate) => candidate !== path);
        if (paths.length === 0) return undefined;
        return {
            ...node,
            paths,
            activePath: node.activePath === path ? paths.at(-1) : node.activePath,
        };
    }
    const first = removeFromAllGroups(node.first, path);
    const second = removeFromAllGroups(node.second, path);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Removes `path` from exactly one group (by id), unlike {@link removeFromAllGroups}. Used by `moveEditorPath`, which
 * must relocate a single occurrence without disturbing the same path open in other groups.
 */
function removeFromGroup(
    node: EditorLayoutNode,
    groupId: string,
    path: string,
): EditorLayoutNode | undefined {
    if (node.type === 'group') {
        if (node.id !== groupId || !node.paths.includes(path)) return node;
        const paths = node.paths.filter((candidate) => candidate !== path);
        if (paths.length === 0) return undefined;
        return {
            ...node,
            paths,
            activePath: node.activePath === path ? paths.at(-1) : node.activePath,
        };
    }
    const first = removeFromGroup(node.first, groupId, path);
    const second = removeFromGroup(node.second, groupId, path);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function removePathsUnderFromNode(
    node: EditorLayoutNode,
    directoryPath: string,
): EditorLayoutNode | undefined {
    if (node.type === 'group') {
        const paths = node.paths.filter((path) => !isPathAtOrBelow(path, directoryPath));
        if (paths.length === 0) return undefined;
        if (paths.length === node.paths.length) return node;
        return {
            ...node,
            paths,
            activePath:
                node.activePath && !paths.includes(node.activePath)
                    ? paths.at(-1)
                    : node.activePath,
        };
    }
    const first = removePathsUnderFromNode(node.first, directoryPath);
    const second = removePathsUnderFromNode(node.second, directoryPath);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function remapPathsInNode(
    node: EditorLayoutNode,
    previousPath: string,
    nextPath: string,
): EditorLayoutNode {
    const remap = (path: string): string =>
        isVirtualEditorTabPath(path) ? path : remapPath(path, previousPath, nextPath);
    if (node.type === 'group') {
        const paths = [...new Set(node.paths.map(remap))];
        const activePath = node.activePath ? remap(node.activePath) : node.activePath;
        if (
            paths.length === node.paths.length &&
            paths.every((path, index) => path === node.paths[index]) &&
            activePath === node.activePath
        )
            return node;
        return { ...node, paths, activePath };
    }
    const first = remapPathsInNode(node.first, previousPath, nextPath);
    const second = remapPathsInNode(node.second, previousPath, nextPath);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function withValidActiveGroup(layout: EditorLayout): EditorLayout {
    if (layout.activeGroupId && findGroup(layout.root, layout.activeGroupId)) return layout;
    return { ...layout, activeGroupId: firstGroup(layout.root)?.id };
}

export function createEditorLayout(path: string, id: LayoutIdFactory = createId): EditorLayout {
    const root = group(path, id);
    return { root, activeGroupId: root.id };
}

export function listLayoutPaths(layout: EditorLayout): string[] {
    const paths: string[] = [];
    const visit = (node?: EditorLayoutNode): void => {
        if (!node) return;
        if (node.type === 'group') {
            paths.push(...node.paths);
            return;
        }
        visit(node.first);
        visit(node.second);
    };
    visit(layout.root);
    return paths;
}

export function firstLayoutPath(layout: EditorLayout): string | undefined {
    return firstGroup(layout.root)?.activePath ?? firstGroup(layout.root)?.paths[0];
}

/**
 * The path shown by the layout's currently active group, if any.
 */
export function activeLayoutPath(layout: EditorLayout): string | undefined {
    const activeGroup = layout.activeGroupId
        ? findGroup(layout.root, layout.activeGroupId)
        : firstGroup(layout.root);
    return activeGroup?.activePath ?? activeGroup?.paths[0];
}

/**
 * Resolves which group owns `path` for read-only lookups: the active group first (a duplicated path is normally meant
 * to stay associated with whichever pane the user is looking at), then the first group in tree order.
 */
export function findPathGroupId(layout: EditorLayout, path: string): string | undefined {
    const activeGroup = layout.activeGroupId
        ? findGroup(layout.root, layout.activeGroupId)
        : undefined;
    if (activeGroup?.paths.includes(path)) return activeGroup.id;
    return findFirstPathGroup(layout.root, path)?.id;
}

/**
 * Activates `path` in the layout. When the same path is open in several groups, `preferredGroupId` wins if that group
 * actually lists the path — this is what a click in a specific pane must do, because {@link findPathGroupId} would
 * otherwise keep the already-active group and the clicked sibling would never receive focus.
 */
export function selectEditorPath(
    layout: EditorLayout,
    path: string,
    preferredGroupId?: string,
): EditorLayout {
    const preferred =
        preferredGroupId && layout.root ? findGroup(layout.root, preferredGroupId) : undefined;
    const groupId = preferred?.paths.includes(path) ? preferred.id : findPathGroupId(layout, path);
    if (!groupId || !layout.root) return layout;
    // Referential no-op so `activateWorkState`-style callers can detect "nothing changed" cheaply.
    if (groupId === layout.activeGroupId && findGroup(layout.root, groupId)?.activePath === path)
        return layout;
    return {
        root: replaceNode(layout.root, groupId, (node) => ({
            ...(node as EditorGroupNode),
            activePath: path,
        })),
        activeGroupId: groupId,
    };
}

export function addEditorPath(
    layout: EditorLayout,
    path: string,
    groupId = layout.activeGroupId,
    id: LayoutIdFactory = createId,
): EditorLayout {
    if (!layout.root) return createEditorLayout(path, id);
    const target = (groupId && findGroup(layout.root, groupId)) ?? firstGroup(layout.root);
    if (!target) return createEditorLayout(path, id);
    if (target.paths.includes(path)) {
        // Referential no-op so callers can detect "nothing changed" cheaply.
        if (target.activePath === path && layout.activeGroupId === target.id) return layout;
        return {
            root: replaceNode(layout.root, target.id, (node) => ({
                ...(node as EditorGroupNode),
                activePath: path,
            })),
            activeGroupId: target.id,
        };
    }
    return {
        root: replaceNode(layout.root, target.id, (node) => {
            const groupNode = node as EditorGroupNode;
            return { ...groupNode, paths: [...groupNode.paths, path], activePath: path };
        }),
        activeGroupId: target.id,
    };
}

/**
 * Removes `path` from every group that lists it. Because the same path may be split across multiple groups, this
 * intentionally differs from `removeTerminal` (which only ever has one owning group to clear).
 */
export function removeEditorPath(layout: EditorLayout, path: string): EditorLayout {
    if (!layout.root) return layout;
    return withValidActiveGroup({ ...layout, root: removeFromAllGroups(layout.root, path) });
}

export function moveEditorPath(
    layout: EditorLayout,
    path: string,
    sourceGroupId: string,
    targetGroupId: string,
): EditorLayout {
    if (!layout.root) return layout;
    const source = findGroup(layout.root, sourceGroupId);
    const target = findGroup(layout.root, targetGroupId);
    if (!source || !target || !source.paths.includes(path)) return layout;
    if (sourceGroupId === targetGroupId) {
        return {
            root: replaceNode(layout.root, sourceGroupId, (node) => ({
                ...(node as EditorGroupNode),
                activePath: path,
            })),
            activeGroupId: sourceGroupId,
        };
    }
    const removedRoot = removeFromGroup(layout.root, sourceGroupId, path);
    const withoutSource = withValidActiveGroup({ ...layout, root: removedRoot });
    return addEditorPath(withoutSource, path, targetGroupId);
}

function countGroups(node: EditorLayoutNode): number {
    if (node.type === 'group') return 1;
    return countGroups(node.first) + countGroups(node.second);
}

/**
 * True when {@link splitEditorPath} would actually grow the tree. Splitting a single-tab group with its own path is
 * allowed (VS Code semantics: side-by-side views of the same file), but the tree stops growing at
 * `MAX_EDITOR_LAYOUT_GROUPS` — without this gate the optimistic UI write would flash a ninth pane that the persistence
 * schema then rejects and rolls back. Callers such as the command `when` gate must use this instead of treating "a
 * group exists" as proof the split will do something.
 */
export function canSplitEditorPath(layout: EditorLayout, targetGroupId: string): boolean {
    if (!layout.root) return false;
    const target = findGroup(layout.root, targetGroupId);
    return target !== undefined && countGroups(layout.root) < MAX_EDITOR_LAYOUT_GROUPS;
}

export function splitEditorPath(
    layout: EditorLayout,
    path: string,
    targetGroupId: string,
    direction: 'left' | 'right' | 'up' | 'down',
    id: LayoutIdFactory = createId,
): EditorLayout {
    if (!layout.root) return layout;
    const target = findGroup(layout.root, targetGroupId);
    if (!target || !canSplitEditorPath(layout, targetGroupId)) return layout;
    const nextGroup = group(path, id);
    const splitId = id();
    const axis: EditorSplitNode['direction'] =
        direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
    const isNewGroupFirst = direction === 'left' || direction === 'up';
    return {
        root: replaceNode(layout.root, targetGroupId, (targetNode) => ({
            type: 'split',
            id: splitId,
            direction: axis,
            ratio: 0.5,
            first: isNewGroupFirst ? nextGroup : targetNode,
            second: isNewGroupFirst ? targetNode : nextGroup,
        })),
        activeGroupId: nextGroup.id,
    };
}

/**
 * Mirrors `resizeSplit` in `terminal-layout.ts`: both only touch the shared `{type, id, ratio, first, second}` split
 * shape, but the two layouts use distinct node types (`EditorLayoutNode` vs `TerminalLayoutNode`), so a single generic
 * helper would need a new shared tree module. Given the small size of this function, a short, independently typed
 * duplicate reads clearer than adding that abstraction.
 */
export function resizeSplit(layout: EditorLayout, splitId: string, ratio: number): EditorLayout {
    if (!layout.root) return layout;
    const boundedRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
    return {
        ...layout,
        root: replaceNode(layout.root, splitId, (node) =>
            node.type === 'split' ? { ...node, ratio: boundedRatio } : node,
        ),
    };
}

/**
 * Rewrites every path under `previousPath` (a renamed or moved file/directory) to its `nextPath` equivalent, exactly
 * mirroring the remap applied to `openTabs` in the Renderer's `document-actions.ts`. Git-diff synthetic tab paths are
 * left untouched.
 */
export function remapEditorLayoutPaths(
    layout: EditorLayout,
    previousPath: string,
    nextPath: string,
): EditorLayout {
    if (!layout.root) return layout;
    return { ...layout, root: remapPathsInNode(layout.root, previousPath, nextPath) };
}

/**
 * Removes every path at or below `directoryPath` (a trashed file or directory), collapsing any group emptied by the
 * removal.
 */
export function removeEditorPathsUnder(layout: EditorLayout, directoryPath: string): EditorLayout {
    if (!layout.root) return layout;
    return withValidActiveGroup({
        ...layout,
        root: removePathsUnderFromNode(layout.root, directoryPath),
    });
}

/**
 * The one read path for a Session's editor layout: the persisted tree when present, else a single-group layout derived
 * from `openTabs`/`activeTab`. Locally constructed states (tests, optimistic patches) may predate the field, so every
 * layout mutation site goes through this instead of trusting `state.editorLayout` directly.
 */
export function sessionEditorLayout(state: {
    activeTab?: WorkItem;
    editorLayout?: EditorLayout;
    openTabs: ReadonlyArray<{ path: string }>;
}): EditorLayout {
    return state.editorLayout ?? deriveDefaultEditorLayout(state.openTabs, state.activeTab);
}

/**
 * Derives a single-group Editor layout from legacy `openTabs`/`activeTab` state that predates the split-layout tree, so
 * a Session written before this feature still renders with a sane default layout. Paths are de-duplicated defensively
 * even though `openTabs` should already be unique, since `editorLayoutSchema` rejects a group with a repeated path.
 */
export function deriveDefaultEditorLayout(
    openTabs: ReadonlyArray<{ path: string }>,
    activeTab?: WorkItem,
    id: LayoutIdFactory = createId,
): EditorLayout {
    if (openTabs.length === 0) return {};
    const paths = [...new Set(openTabs.map((tab) => tab.path))];
    const activePath =
        activeTab?.kind === 'editor' && paths.includes(activeTab.path)
            ? activeTab.path
            : paths.at(0);
    const root: EditorGroupNode = { type: 'group', id: id(), paths, activePath };
    return { root, activeGroupId: root.id };
}
