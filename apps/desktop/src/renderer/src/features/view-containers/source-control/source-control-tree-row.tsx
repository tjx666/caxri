import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useContextMenu } from '../../../hooks/use-context-menu';
import { useTranslation } from '../../../i18n';
import type { ContextMenuEntries } from '../../../lib/context-menu';
import { showContextMenu } from '../../../lib/context-menu';
import { cn } from '../../../lib/utilities';
import type { SourceControlRowMenuItem } from './source-control-row-menu';
import { treeRowTabIndex, useSourceControlTreeFocus } from './source-control-tree-focus';

/**
 * One `treeitem` of the Source Control tree: a row that participates in the single roving tabindex, in arrow-key
 * navigation, and, when it has actions, in `Shift+F10`.
 *
 * Every focusable row in the panel goes through here. Commit rows, `Load more`, and the File History and `Commits`
 * headers used to be plain buttons, which put a Tab stop on each one and left those sections unreachable by the arrow
 * keys, because arrow navigation only walks `[role="treeitem"]`.
 */
export function SourceControlTreeRow({
    children,
    level,
    menuItems,
    onFocus,
    onKeyDown,
    rowId,
    tooltip,
    ...properties
}: ButtonHTMLAttributes<HTMLButtonElement> & {
    level: number;
    menuItems?: readonly SourceControlRowMenuItem[];
    rowId: string;
    /**
     * Rich hover text for a row whose own label is truncated, or whose modifier gestures need naming. Rows pass this
     * instead of `title`: the native tooltip is slow, unstyled, and cannot show the second line. A row that needs its
     * path readable from the DOM writes `data-path` as well: setting `title` beside this would stack a second, native
     * tooltip on the same hover.
     */
    tooltip?: ReactNode;
}) {
    const { t } = useTranslation();
    const focus = useSourceControlTreeFocus();
    const hasMenu = Boolean(menuItems?.length);
    const menu = (): ContextMenuEntries =>
        (menuItems ?? []).map((item) => ({
            label: item.label,
            disabled: item.disabled,
            onSelect: item.run,
        }));
    const openContextMenu = useContextMenu(menu);
    const row = (
        <button
            {...properties}
            className={cn(
                'outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
                properties.className,
            )}
            aria-level={level}
            aria-description={
                [
                    properties['aria-description'],
                    hasMenu && t('viewContainers.sourceControl.rowMenuHint'),
                ]
                    .filter(Boolean)
                    .join(t('viewContainers.sourceControl.hintSeparator')) || undefined
            }
            data-row-id={rowId}
            role="treeitem"
            tabIndex={treeRowTabIndex(focus.activeRowId, rowId)}
            type="button"
            onFocus={(event) => {
                focus.focusRow(rowId);
                onFocus?.(event);
            }}
            onContextMenu={(event) => {
                properties.onContextMenu?.(event);
                if (hasMenu) openContextMenu(event);
            }}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!hasMenu || event.defaultPrevented) return;
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    /**
                     * MacOS Chromium does not turn these keys into a `contextmenu` event, so the row opens its menu
                     * itself, anchored under the row instead of at a pointer the keyboard user never moved.
                     */
                    const bounds = event.currentTarget.getBoundingClientRect();
                    // `showContextMenu` reports its own failures through a toast; nothing to await in a key handler.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void showContextMenu(menu(), { x: bounds.left, y: bounds.bottom });
                }
            }}
        >
            {children}
        </button>
    );
    /**
     * `hoverOnly` because this row is one the app itself focuses: the tree moves focus between rows programmatically
     * through its roving `tabIndex`, and a focus-opened tooltip would pop up on every arrow-key step. The tooltip's
     * text is the resource path, which is already this row's accessible name, so a screen reader still hears it.
     */
    if (tooltip === undefined) return row;
    return (
        <Tooltip anchorMode="cursor" content={tooltip} hoverOnly>
            {row}
        </Tooltip>
    );
}
