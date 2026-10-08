import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { useId, useRef } from 'react';

import { cn } from '../../lib/utilities';
import type { ExtensionTreeNavigationKey } from './extension-tree-navigation';
import { ExtensionTreeRowContent, ExtensionTreeRowTooltip } from './extension-tree-row-content';
import type { VisibleItemRow } from './extension-tree-rows';
import type { TreeRowAction } from './extension-tree-state';
import { keyboardTreeRowAction, pointerTreeRowAction } from './extension-tree-state';

/**
 * Every navigation key is resolved against the flat row list by `onNavigate`, which the tree owns: the row knows its
 * own index and nothing else, so it cannot see the status rows it has to step over or the child it has to step into.
 * That also keeps the whole row list out of the memoized row component's props.
 */
function handleTreeItemKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    {
        dispatchRowAction,
        index,
        onNavigate,
        row,
    }: {
        dispatchRowAction: (action: TreeRowAction) => void;
        index: number;
        onNavigate: (key: ExtensionTreeNavigationKey, index: number) => void;
        row: VisibleItemRow;
    },
): void {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Home':
        case 'End':
            onNavigate(event.key, index);
            break;
        case 'Enter':
        case ' ':
            dispatchRowAction(keyboardTreeRowAction(row.item, event.key));
            break;
        default:
            return;
    }
    event.preventDefault();
}

function treeItemPresentation(row: VisibleItemRow, isRefreshing: boolean) {
    const isHeader = row.item.variant === 'header';
    const isMessage = row.item.variant === 'message';
    const isRefreshingMessage = isMessage && isRefreshing;
    return {
        className: cn(
            // Hover and keyboard focus only: this tree has no persistent selected row, so it must not borrow a
            // selection color to stand in for one. Keyboard focus adds the accent inset ring the Files and Source
            // Control trees already draw, because the focus fill alone is a wash the pointer can paint too.
            'group/tree-row flex w-full min-w-0 items-center gap-2 border-0 bg-transparent text-left text-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none',
            isHeader ? 'h-8 border-b border-border font-semibold' : isMessage ? 'min-h-40' : 'h-7',
            !isMessage
                ? 'pr-2 hover:bg-list-hover-background hover:text-list-hover-foreground'
                : undefined,
            !isMessage && row.item.command ? 'cursor-pointer' : undefined,
        ),
        commandTarget: !isRefreshingMessage && row.item.command ? 'true' : undefined,
        isCollapsible: row.item.collapsibleState !== 'none',
        isMessage,
        isRefreshingMessage,
        style: isMessage ? undefined : { paddingLeft: `${8 + row.depth * 14}px` },
        tooltip:
            row.item.tooltip ??
            (row.item.description ? `${row.item.label} — ${row.item.description}` : row.item.label),
    };
}

function dispatchTreeRowAction({
    action,
    isRefreshingMessage,
    onAction,
    row,
}: {
    action: TreeRowAction;
    isRefreshingMessage: boolean;
    onAction: (row: VisibleItemRow, action: TreeRowAction) => void;
    row: VisibleItemRow;
}): void {
    if (isRefreshingMessage && action === 'activate') return;
    onAction(row, action);
}

function handleTreeItemClick(
    event: MouseEvent<HTMLDivElement>,
    rowElement: RefObject<HTMLDivElement | null>,
    row: VisibleItemRow,
    dispatchRowAction: (action: TreeRowAction) => void,
): void {
    rowElement.current?.focus();
    if (row.item.variant === 'message') return;
    dispatchRowAction(pointerTreeRowAction(row.item, 'body', 'click', event.detail, event.altKey));
}

/**
 * Keeps one roving treeitem focus target while giving the disclosure its own pointer and accessible hit area. The
 * disclosure stays outside the tab order because Enter activates the row and Space expands it; pointer activation
 * restores focus to the treeitem before changing expansion. The tree renders it through `memo` so a focus change or
 * refresh re-renders only the rows whose own props changed.
 */
export function ExtensionTreeItemRow({
    active,
    index,
    isRefreshing,
    onAction,
    onNavigate,
    onFocus,
    row,
}: {
    active: boolean;
    index: number;
    /**
     * Only message rows react to a root refresh; item rows receive `false` so a refresh does not re-render them.
     */
    isRefreshing: boolean;
    onAction: (row: VisibleItemRow, action: TreeRowAction) => void;
    onNavigate: (key: ExtensionTreeNavigationKey, index: number) => void;
    onFocus: (row: VisibleItemRow) => void;
    row: VisibleItemRow;
}) {
    const { isExpanded, positionInSet, setSize } = row;
    const rowElement = useRef<HTMLDivElement>(null);
    const actionsDescriptionId = useId();
    const presentation = treeItemPresentation(row, isRefreshing);
    const dispatchRowAction = (action: TreeRowAction): void =>
        dispatchTreeRowAction({
            action,
            isRefreshingMessage: presentation.isRefreshingMessage,
            onAction,
            row,
        });
    const treeItem = (
        <div
            aria-busy={presentation.isRefreshingMessage || undefined}
            aria-describedby={
                !presentation.isMessage && row.item.actions?.length
                    ? actionsDescriptionId
                    : undefined
            }
            aria-disabled={presentation.isRefreshingMessage || undefined}
            aria-expanded={presentation.isCollapsible ? isExpanded : undefined}
            aria-label={row.item.accessibilityLabel}
            aria-level={row.depth + 1}
            aria-posinset={positionInSet}
            aria-selected={active}
            aria-setsize={setSize}
            className={presentation.className}
            data-tree-command-target={presentation.commandTarget}
            data-tree-index={index}
            data-tree-item-variant={row.item.variant}
            ref={rowElement}
            role="treeitem"
            style={presentation.style}
            tabIndex={active ? 0 : -1}
            onClick={(event) => handleTreeItemClick(event, rowElement, row, dispatchRowAction)}
            onFocus={() => onFocus(row)}
            onKeyDown={(event) =>
                handleTreeItemKeyDown(event, {
                    dispatchRowAction,
                    index,
                    onNavigate,
                    row,
                })
            }
        >
            <ExtensionTreeRowContent
                actionsDescriptionId={actionsDescriptionId}
                dispatchRowAction={dispatchRowAction}
                isRefreshing={isRefreshing}
                row={row}
                rowElement={rowElement}
            />
        </div>
    );
    return (
        <ExtensionTreeRowTooltip
            isMessage={presentation.isMessage}
            tooltip={presentation.tooltip}
            trigger={treeItem}
        />
    );
}
