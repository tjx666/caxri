import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';

import type { SourceControlAction } from '@caxri/protocol';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import { cn } from '../../../lib/utilities';

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
    return (
        <TreeFocusContext.Provider value={{ activeRowId, focusRow }}>
            {children}
        </TreeFocusContext.Provider>
    );
}

export function SourceControlTreeRow({
    children,
    level,
    menuActions,
    onFocus,
    onKeyDown,
    onMenuAction,
    rowId,
    ...properties
}: ButtonHTMLAttributes<HTMLButtonElement> & {
    level: number;
    menuActions?: readonly SourceControlAction[];
    onMenuAction?: (action: SourceControlAction) => void;
    rowId: string;
}) {
    const focus = useContext(TreeFocusContext);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    if (!focus) throw new Error('Source Control tree row has no focus owner');
    const row = (
        <button
            {...properties}
            className={cn(
                'outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
                properties.className,
            )}
            aria-level={level}
            aria-description={menuActions?.length ? 'Press Shift+F10 for actions' : undefined}
            data-row-id={rowId}
            role="treeitem"
            tabIndex={focus.activeRowId === rowId ? 0 : -1}
            type="button"
            onFocus={(event) => {
                focus.focusRow(rowId);
                onFocus?.(event);
            }}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!onMenuAction || !menuActions?.length || event.defaultPrevented) return;
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    setIsMenuOpen(true);
                }
            }}
        >
            {children}
        </button>
    );
    if (!onMenuAction || !menuActions?.length) return row;
    return (
        <ContextMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <ContextMenuTrigger render={row} />
            <ContextMenuContent>
                {menuActions.map((action) => (
                    <ContextMenuItem
                        key={action.id}
                        disabled={action.disabled}
                        onClick={() => onMenuAction(action)}
                    >
                        {action.label}
                    </ContextMenuItem>
                ))}
            </ContextMenuContent>
        </ContextMenu>
    );
}
