import type { ButtonHTMLAttributes } from 'react';
import { useState } from 'react';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import { cn } from '../../../lib/utilities';
import type { SourceControlRowMenuItem } from './source-control-row-menu';
import { treeRowTabIndex, useSourceControlTreeFocus } from './source-control-tree-focus';

/**
 * One `treeitem` of the Source Control tree: a row that participates in the single roving tabindex, in arrow-key
 * navigation, and — when it has actions — in `Shift+F10`.
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
    ...properties
}: ButtonHTMLAttributes<HTMLButtonElement> & {
    level: number;
    menuItems?: readonly SourceControlRowMenuItem[];
    rowId: string;
}) {
    const focus = useSourceControlTreeFocus();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const row = (
        <button
            {...properties}
            className={cn(
                'outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
                properties.className,
            )}
            aria-level={level}
            aria-description={menuItems?.length ? 'Press Shift+F10 for actions' : undefined}
            data-row-id={rowId}
            role="treeitem"
            tabIndex={treeRowTabIndex(focus.activeRowId, rowId)}
            type="button"
            onFocus={(event) => {
                focus.focusRow(rowId);
                onFocus?.(event);
            }}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!menuItems?.length || event.defaultPrevented) return;
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    setIsMenuOpen(true);
                }
            }}
        >
            {children}
        </button>
    );
    if (!menuItems?.length) return row;
    return (
        <ContextMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <ContextMenuTrigger render={row} />
            <ContextMenuContent>
                {menuItems.map((item) => (
                    <ContextMenuItem key={item.id} disabled={item.disabled} onClick={item.run}>
                        {item.label}
                    </ContextMenuItem>
                ))}
            </ContextMenuContent>
        </ContextMenu>
    );
}
