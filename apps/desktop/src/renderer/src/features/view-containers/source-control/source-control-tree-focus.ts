import type { ReactNode } from 'react';
import { createContext, createElement, useContext, useMemo } from 'react';

/**
 * Roving-tabindex ownership for the Source Control `role="tree"` widget.
 *
 * The tree is assembled from independently fetched sections (working-tree changes, File History, one `Commits` section
 * per repository), so there is no single Renderer-side list of visible rows; `source-control-content.tsx` reads the
 * rendered `[role="treeitem"]` rows out of the DOM in document order and hands their ids to the arithmetic below, which
 * stays free of React and the DOM so the "exactly one Tab stop" contract is testable on its own.
 */

/**
 * Which row owns the tree's single Tab stop.
 *
 * A background refresh replaces the whole view model many times a minute, so the previously active row may no longer
 * exist. Falling back to the first row (rather than clearing the selection) is what keeps the tree Tab-reachable at
 * all: with no active row every row would carry `tabIndex={-1}` and Tab would skip the widget entirely.
 *
 * An empty row list keeps the remembered id instead, so a render that momentarily draws no rows does not discard the
 * position the user was at.
 */
export function resolveActiveTreeRowId(
    rowIds: readonly string[],
    activeRowId: string | undefined,
): string | undefined {
    if (activeRowId !== undefined && rowIds.includes(activeRowId)) return activeRowId;
    return rowIds.length > 0 ? rowIds[0] : activeRowId;
}

/**
 * The `tabIndex` one row carries: `0` for the single roving Tab stop, `-1` for every other row.
 */
export function treeRowTabIndex(activeRowId: string | undefined, rowId: string): 0 | -1 {
    return activeRowId === rowId ? 0 : -1;
}

/**
 * Whether the tree may claim `key` while focus sits in a text field hosted inside a row: the per-repository commit path
 * filter is the only one.
 *
 * `treeitem` is not a children-presentational role, so a textbox nested in a row is the one place a text field can
 * legally live inside `role="tree"`. The cost is that the row's navigation keys and the field's editing keys overlap:
 * `ArrowLeft`/`ArrowRight` move the caret and `Home`/`End` jump within the value. Only the vertical pair is handed to
 * the tree, which is how VS Code's SCM input box hands off to the list below it.
 */
export function shouldTreeClaimKeyInTextField(key: string): boolean {
    return key === 'ArrowDown' || key === 'ArrowUp';
}

/**
 * Whether a keyboard event that originated at `element` is text entry rather than row navigation.
 */
export function isTextEntryElement(element: Element | null): boolean {
    if (!(element instanceof HTMLElement)) return false;
    if (element.isContentEditable) return true;
    const tagName = element.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
}

interface TreeFocusContextValue {
    activeRowId: string | undefined;
    focusRow: (rowId: string) => void;
}

const TreeFocusContext = createContext<TreeFocusContextValue | undefined>(undefined);

export function SourceControlTreeFocusProvider({
    activeRowId,
    children,
    focusRow,
}: TreeFocusContextValue & { children: ReactNode }) {
    const value = useMemo(() => ({ activeRowId, focusRow }), [activeRowId, focusRow]);
    return createElement(TreeFocusContext, { value }, children);
}

/**
 * The tree's single roving Tab stop. Every row inside `role="tree"` reads it, including the rows that are not plain
 * buttons (the commit path filter), so they all agree on which one element is tabbable.
 */
export function useSourceControlTreeFocus(): TreeFocusContextValue {
    const focus = useContext(TreeFocusContext);
    if (!focus) throw new Error('Source Control tree row has no focus owner');
    return focus;
}
