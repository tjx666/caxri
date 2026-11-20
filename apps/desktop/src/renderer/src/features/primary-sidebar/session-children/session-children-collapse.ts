import { createSharedLocalState } from '../../../lib/local-storage';
import { createStore } from '../../../lib/store';

/**
 * Host Session ids whose child rows (subagents and nested delegated Sessions) the user folded away. Only collapsed
 * hosts are stored: expanded is the default, so expanding a host removes its key.
 */
export type SessionChildrenCollapseState = Readonly<Partial<Record<string, true>>>;

export const SESSION_CHILDREN_COLLAPSE_STORAGE_KEY =
    'caxri.primary-sidebar-session-children-collapse.v1';

/**
 * Keeps only `true` entries; anything else an older or corrupt write left is dropped, which reads as expanded.
 */
export function parseSessionChildrenCollapse(stored: unknown): SessionChildrenCollapseState {
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    return Object.fromEntries(
        Object.entries(stored).filter((entry): entry is [string, true] => entry[1] === true),
    );
}

/**
 * Whether a Session row's child rows are shown: `undefined` when it has none (no disclosure), else `false` while the
 * user folded them.
 */
export function sessionChildrenExpanded(
    sessionId: string,
    hasChildren: boolean,
    collapsed: SessionChildrenCollapseState,
): boolean | undefined {
    if (!hasChildren) return undefined;
    return collapsed[sessionId] !== true;
}

/**
 * Shared by every window of the profile (docs/client-local-data.md). Keyed by host Session id, so folding one host
 * patches only that key and keeps what another window folded meanwhile.
 */
const sharedCollapse = createSharedLocalState(
    SESSION_CHILDREN_COLLAPSE_STORAGE_KEY,
    parseSessionChildrenCollapse,
);

/**
 * Which host Sessions fold their child rows in the PrimarySidebar (issue #4065). A store rather than props so toggling
 * one host re-renders only that host's row and children, and the tree's keyboard row order reads the same answer.
 */
export const useSessionChildrenCollapseStore = createStore<{
    collapsed: SessionChildrenCollapseState;
}>('primarySidebarSessionChildrenCollapse', (set) => {
    // Memory only, so another window's fold never writes back.
    sharedCollapse.subscribe((collapsed) => set({ collapsed }));
    return { collapsed: sharedCollapse.read() };
});

/**
 * Folds or unfolds one host's child rows and persists the change for every window.
 */
export function setSessionChildrenCollapsed(sessionId: string, isCollapsed: boolean): void {
    const current = useSessionChildrenCollapseStore.getState().collapsed;
    if ((current[sessionId] === true) === isCollapsed) return;
    const next = { ...current };
    if (isCollapsed) next[sessionId] = true;
    else delete next[sessionId];
    // The in-memory record stays the base so a window without storage still remembers its own folds.
    useSessionChildrenCollapseStore.setState({
        collapsed: { ...next, ...sharedCollapse.patch({ [sessionId]: isCollapsed || undefined }) },
    });
}

export function toggleSessionChildrenCollapsed(sessionId: string): void {
    const isCollapsed = useSessionChildrenCollapseStore.getState().collapsed[sessionId] === true;
    setSessionChildrenCollapsed(sessionId, !isCollapsed);
}
