import type { WorkItem } from '../../packages/protocol/src/domain/work-item';
import { activeLayoutTerminalId, firstLayoutTerminalId, selectTerminal } from './terminal-layout';
import type { SessionState } from './types';

/**
 * The single model for "what is focused in the center pane": either a Terminal (by id) or an open
 * editor tab (by file path). Replaces the historical `terminal:<id>` / `editor:<path>` string-prefix
 * encoding that was parsed with `startsWith`/`slice` across the Renderer.
 */
export type { WorkItem } from '../../packages/protocol/src/domain/work-item';

/**
 * Stable string key for React list/map identity. It is not a persistence format; the canonical
 * protocol schema validates durable values. Built from the discriminant field itself so no `kind`
 * literal needs to be hardcoded.
 */
export function workItemKey(item: WorkItem | undefined): string {
    if (!item) return 'none';
    return `${item.kind}:${item.kind === 'terminal' ? item.terminalId : item.path}`;
}

export function workItemsEqual(a: WorkItem | undefined, b: WorkItem | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'terminal' && b.kind === 'terminal'
        ? a.terminalId === b.terminalId
        : a.kind === 'editor' && b.kind === 'editor' && a.path === b.path;
}

function workItemExists(
    item: WorkItem | undefined,
    sessionTerminals: readonly { id: string }[],
    openTabs: readonly { path: string }[],
): boolean {
    if (!item) return false;
    return item.kind === 'terminal'
        ? sessionTerminals.some((terminal) => terminal.id === item.terminalId)
        : openTabs.some((tab) => tab.path === item.path);
}

/**
 * The only place fallback logic for the active work item lives. Preference order: (1) the locally
 * tracked `activeWork` if its target still exists in this Session, (2) the persisted
 * `sessionState.activeTab` if its target still exists (it can go stale when its Terminal is closed or
 * removed without an explicit `activateWork` call), (3) the first still-present Terminal in the
 * layout, (4) the first Session Terminal if the layout has none, or (5) the first open editor. The
 * final editor fallback keeps exactly one Work tab active/focusable after every Terminal is removed.
 */
export function resolveActiveWork(params: {
    activeWork?: WorkItem;
    sessionTerminals: readonly { id: string }[];
    sessionState?: Pick<SessionState, 'activeTab' | 'openTabs' | 'layout'>;
}): WorkItem | undefined {
    const { activeWork, sessionTerminals, sessionState } = params;
    const openTabs = sessionState?.openTabs ?? [];
    if (workItemExists(activeWork, sessionTerminals, openTabs)) return activeWork;
    if (workItemExists(sessionState?.activeTab, sessionTerminals, openTabs))
        return sessionState?.activeTab;
    const layoutTerminalId = sessionState && firstLayoutTerminalId(sessionState.layout);
    const fallbackTerminalId = sessionTerminals.some((terminal) => terminal.id === layoutTerminalId)
        ? layoutTerminalId
        : sessionTerminals[0]?.id;
    if (fallbackTerminalId) return { kind: 'terminal', terminalId: fallbackTerminalId };
    const fallbackEditor = openTabs[0];
    return fallbackEditor ? { kind: 'editor', path: fallbackEditor.path } : undefined;
}

/**
 * The single write path for "activate this WorkItem": persists `activeTab` and, for a Terminal,
 * syncs the Terminal layout's active group/Terminal in the same update. Returns `state` unchanged
 * when activation is a no-op, so callers can skip persisting. App.tsx's `activateWork` wraps this
 * with the local `activeWork` state setter.
 */
export function activateWorkState(state: SessionState, item: WorkItem): SessionState {
    if (item.kind !== 'terminal') {
        if (workItemsEqual(state.activeTab, item)) return state;
        return { ...state, activeTab: item };
    }
    const alreadyActive = activeLayoutTerminalId(state.layout) === item.terminalId;
    if (alreadyActive && workItemsEqual(state.activeTab, item)) return state;
    return { ...state, activeTab: item, layout: selectTerminal(state.layout, item.terminalId) };
}
