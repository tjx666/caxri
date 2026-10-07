import { useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { ExtensionTreeActionIcon } from './extension-tree-item-icon';
import type { TreeItemAction } from './tree-item-actions';
import { runTreeItemAction } from './tree-item-actions';

function TreeItemActionButton({ action }: { action: TreeItemAction }) {
    const [isRunning, setIsRunning] = useState(false);
    return (
        <Tooltip content={action.command.title}>
            <Button
                aria-label={action.command.title}
                aria-busy={isRunning || undefined}
                className="size-5"
                data-tree-item-action={action.command.id}
                disabled={isRunning}
                size="icon"
                tabIndex={-1}
                variant="ghost"
                onClick={(event) => {
                    // The row behind the button activates its own command on click; an inline action must not also
                    // open the pull request.
                    event.stopPropagation();
                    setIsRunning(true);
                    // eslint-disable-next-line no-void -- dispatch failures surface through the shared toast path
                    void runTreeItemAction(action).finally(() => setIsRunning(false));
                }}
                onDoubleClick={(event) => event.stopPropagation()}
            >
                {isRunning ? (
                    <Spinner aria-hidden="true" className="size-3.5" />
                ) : (
                    <ExtensionTreeActionIcon icon={action.icon} />
                )}
            </Button>
        </Tooltip>
    );
}

/**
 * Inline actions sit at the end of the row and appear on hover or keyboard focus, the same reveal the Source Control
 * tree uses for its per-file actions, so a quiet panel does not fill up with buttons.
 */
export function ExtensionTreeRowActions({ actions }: { actions: TreeItemDto['actions'] }) {
    if (!actions?.length) return null;
    return (
        <span
            className={cn(
                'hidden shrink-0 items-center gap-0.5',
                'group-focus-within/tree-row:flex group-hover/tree-row:flex has-[[aria-busy=true]]:flex',
            )}
            data-tree-item-actions="true"
        >
            {actions.map((action) => (
                <TreeItemActionButton action={action} key={action.command.id} />
            ))}
        </span>
    );
}
