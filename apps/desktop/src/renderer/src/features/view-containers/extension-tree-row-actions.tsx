import type { FocusEvent, KeyboardEvent, RefObject } from 'react';
import { useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { ExtensionTreeActionIcon } from './extension-tree-item-icon';
import type { TreeItemAction } from './tree-item-actions';
import { runTreeItemAction, treeItemActionKeyIntent } from './tree-item-actions';

function TreeItemActionButton({
    action,
    isTabStop,
}: {
    action: TreeItemAction;
    isTabStop: boolean;
}) {
    const [isRunning, setIsRunning] = useState(false);
    return (
        // Hover only: the tree moves focus onto these buttons itself (Right from the row, and the confirmation modal
        // handing focus back), and a focus-opened tooltip would both pop up unasked and consume the Escape that returns
        // to the row. The title is the button's accessible name, so a screen reader still hears it.
        <Tooltip hoverOnly content={action.command.title}>
            <Button
                aria-label={action.command.title}
                aria-busy={isRunning || undefined}
                // `aria-disabled` rather than `disabled`: Chromium evicts focus from a button the moment it becomes
                // disabled, and the confirmation modal hands focus back to this button when it closes. A natively
                // disabled button would drop a keyboard user to the document body on Cancel.
                aria-disabled={isRunning || undefined}
                className="size-5 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none"
                data-tree-item-action={action.command.id}
                size="icon"
                tabIndex={isTabStop ? 0 : -1}
                variant="ghost"
                onClick={(event) => {
                    // The row behind the button activates its own command on click; an inline action must not also
                    // open the pull request.
                    event.stopPropagation();
                    if (isRunning) return;
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

function actionButtons(group: HTMLElement): HTMLButtonElement[] {
    return [...group.querySelectorAll<HTMLButtonElement>('[data-tree-item-action]')];
}

/**
 * Left/Right walk the row's actions, Left from the first one or Escape returns to the row, and Enter/Space click the
 * focused button natively. Keys the group handles stop here so the row's own handler, which the event would otherwise
 * bubble to, does not also treat them as tree navigation or row activation.
 */
function handleActionGroupKeyDown(
    event: KeyboardEvent<HTMLSpanElement>,
    rowElement: RefObject<HTMLDivElement | null>,
): void {
    if (event.nativeEvent.isComposing) return;
    const buttons = actionButtons(event.currentTarget);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index === -1) return;
    const intent = treeItemActionKeyIntent(event.key, index, buttons.length);
    if (!intent) return;
    event.stopPropagation();
    if (intent.kind === 'native') return;
    event.preventDefault();
    if (intent.kind === 'row') rowElement.current?.focus();
    else if (intent.kind === 'focus') buttons[intent.index]?.focus();
}

/**
 * Inline actions sit at the end of the row and appear on hover or keyboard focus, the same reveal the Source Control
 * tree uses for its per-file actions, so a quiet panel does not fill up with buttons.
 *
 * Keyboard users reach them with Right from the row (see `extensionTreeHorizontalIntent`). The buttons use a roving
 * tabindex scoped to the group: while focus is inside it, the focused action is the one Tab stop, so Tab and Shift+Tab
 * leave the way they would from any control; once focus leaves, every action drops back to `-1` and the tree keeps its
 * single row Tab stop.
 */
export function ExtensionTreeRowActions({
    actions,
    descriptionId,
    rowElement,
}: {
    actions: TreeItemDto['actions'];
    /**
     * Id of the visually hidden summary the row references through `aria-describedby`, so a screen reader hears that
     * the row has actions and how to reach them while the buttons themselves are still hidden.
     */
    descriptionId: string;
    rowElement: RefObject<HTMLDivElement | null>;
}) {
    const [focusedCommandId, setFocusedCommandId] = useState<string>();
    if (!actions?.length) return null;
    return (
        <>
            <span className="sr-only" id={descriptionId}>
                {`Actions: ${actions.map(({ command }) => command.title).join(', ')}. Press Right Arrow to reach them.`}
            </span>
            <span
                className={cn(
                    'hidden shrink-0 items-center gap-0.5',
                    'group-focus-within/tree-row:flex group-hover/tree-row:flex has-[[aria-busy=true]]:flex',
                )}
                data-tree-item-actions="true"
                onBlur={(event: FocusEvent<HTMLSpanElement>) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                        setFocusedCommandId(undefined);
                }}
                onFocus={(event: FocusEvent<HTMLSpanElement>) =>
                    setFocusedCommandId(event.target.dataset.treeItemAction ?? undefined)
                }
                onKeyDown={(event) => handleActionGroupKeyDown(event, rowElement)}
            >
                {actions.map((action) => (
                    <TreeItemActionButton
                        action={action}
                        isTabStop={focusedCommandId === action.command.id}
                        key={action.command.id}
                    />
                ))}
            </span>
        </>
    );
}
