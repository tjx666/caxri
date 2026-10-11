import type { ReactElement, RefObject } from 'react';

import type { TreeItemDto } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { ExtensionTreeItemIcon, ExtensionTreeTrailingIcon } from './extension-tree-item-icon';
import { ExtensionTreeMessage } from './extension-tree-message';
import { ExtensionTreeRowActions } from './extension-tree-row-actions';
import type { VisibleItemRow } from './extension-tree-rows';
import type { TreeRowAction } from './extension-tree-state';
import { pointerTreeRowAction } from './extension-tree-state';
import { ExtensionTreeTooltip } from './extension-tree-tooltip';

export function ExtensionTreeRowContent({
    actionsDescriptionId,
    dispatchRowAction,
    isRefreshing,
    row,
    rowElement,
}: {
    actionsDescriptionId: string;
    dispatchRowAction: (action: TreeRowAction) => void;
    isRefreshing: boolean;
    row: VisibleItemRow;
    rowElement: RefObject<HTMLDivElement | null>;
}) {
    const isCollapsible = row.item.collapsibleState !== 'none';
    const isExpanded = row.isExpanded;
    const isMessage = row.item.variant === 'message';
    if (isMessage)
        return (
            <ExtensionTreeMessage
                actionLabel={row.item.command?.title}
                description={row.item.description}
                disabled={isRefreshing}
                icon={<ExtensionTreeItemIcon icon={row.item.icon} size={24} />}
                title={row.item.label}
                onAction={() => dispatchRowAction('activate')}
            />
        );
    return (
        <>
            {isCollapsible ? (
                <button
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${row.item.accessibilityLabel}`}
                    className="-m-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted hover:text-foreground"
                    data-tree-disclosure="true"
                    tabIndex={-1}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        rowElement.current?.focus();
                        dispatchRowAction(
                            pointerTreeRowAction(
                                row.item,
                                'disclosure',
                                'click',
                                event.detail,
                                event.altKey,
                            ),
                        );
                    }}
                >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
            ) : (
                <span className="w-[13px] shrink-0" />
            )}
            <ExtensionTreeItemIcon className="shrink-0" icon={row.item.icon} size={14} />
            <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
            {row.item.description && (
                <span className="max-w-[45%] min-w-0 shrink truncate text-[11px] font-normal text-muted">
                    {row.item.description}
                </span>
            )}
            <ExtensionTreeTrailingIcon icon={row.item.trailingIcon} />
            <ExtensionTreeRowActions
                actions={row.item.actions}
                descriptionId={actionsDescriptionId}
                isCollapsedBranch={isCollapsible && !isExpanded}
                rowElement={rowElement}
            />
        </>
    );
}

export function ExtensionTreeRowTooltip({
    isMessage,
    tooltip,
    trigger,
}: {
    isMessage: boolean;
    tooltip: NonNullable<TreeItemDto['tooltip']>;
    trigger: ReactElement<Record<string, unknown>>;
}) {
    if (isMessage) return trigger;
    return typeof tooltip === 'string' ? (
        <Tooltip anchorMode="cursor" content={tooltip}>
            {trigger}
        </Tooltip>
    ) : (
        <ExtensionTreeTooltip tooltip={tooltip} trigger={trigger} />
    );
}
