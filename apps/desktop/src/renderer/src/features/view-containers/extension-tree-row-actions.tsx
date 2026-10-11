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

const labeledActionToneClassNames: Record<NonNullable<TreeItemAction['tone']>, string> = {
    danger: 'border-danger/40 bg-danger/10 text-danger',
    neutral: 'border-border text-foreground',
    success: 'border-success/40 bg-success/10 text-success',
    warning: 'border-warning/40 bg-warning/10 text-warning',
};

const iconActionToneClassNames: Record<NonNullable<TreeItemAction['tone']>, string> = {
    danger: 'text-danger',
    neutral: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
};

/**
 * A labeled or toned action carries state, so it stays on screen at rest; plain icon actions wait for hover.
 */
function isPersistentAction(action: TreeItemAction): boolean {
    return action.label !== undefined || action.tone !== undefined;
}

/**
 * The accessible name keeps the command's title and adds the visible label when the title does not already contain it,
 * so a voice-control user can say what they see ("Checks running") and a screen reader still hears the action.
 */
function actionAccessibleName(action: TreeItemAction): string {
    const { label } = action;
    const { title } = action.command;
    return !label || title.toLowerCase().includes(label.toLowerCase())
        ? title
        : `${title} (${label})`;
}

function TreeItemActionButton({
    action,
    isRevealedOnHover,
    isTabStop,
}: {
    action: TreeItemAction;
    /**
     * Set for a plain icon action sharing a group that stays visible because of a labeled or toned sibling.
     */
    isRevealedOnHover: boolean;
    isTabStop: boolean;
}) {
    const [isRunning, setIsRunning] = useState(false);
    const isLabeled = action.label !== undefined;
    return (
        // Hover only: the tree moves focus onto these buttons itself (Right from the row, and the confirmation modal
        // handing focus back), and a focus-opened tooltip would both pop up unasked and consume the Escape that returns
        // to the row. The title is the button's accessible name, so a screen reader still hears it.
        <Tooltip hoverOnly content={action.command.title}>
            <Button
                aria-label={actionAccessibleName(action)}
                aria-busy={isRunning || undefined}
                // `aria-disabled` rather than `disabled`: Chromium evicts focus from a button the moment it becomes
                // disabled, and the confirmation modal hands focus back to this button when it closes. A natively
                // disabled button would drop a keyboard user to the document body on Cancel.
                aria-disabled={isRunning || undefined}
                className={cn(
                    'focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none',
                    isLabeled
                        ? cn(
                              'h-5 min-h-5 gap-1 px-1.5 text-[11px] font-medium enabled:not-aria-disabled:hover:brightness-125',
                              labeledActionToneClassNames[action.tone ?? 'neutral'],
                          )
                        : cn('size-5', action.tone && iconActionToneClassNames[action.tone]),
                    isRevealedOnHover &&
                        'hidden group-focus-within/tree-row:inline-flex group-hover/tree-row:inline-flex aria-busy:inline-flex',
                )}
                data-tree-item-action={action.command.id}
                size={isLabeled ? 'sm' : 'icon'}
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
                {action.label}
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
 * tree uses for its per-file actions, so a quiet panel does not fill up with buttons. A labeled or toned action is the
 * exception: its text or color carries state (a green Merge versus a warning-colored merge glyph), so it stays visible
 * at rest and only its plain icon siblings wait for hover.
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
    const hasPersistentAction = actions.some(isPersistentAction);
    return (
        <>
            <span className="sr-only" id={descriptionId}>
                {`Actions: ${actions.map(({ command }) => command.title).join(', ')}. Press Right Arrow to reach them.`}
            </span>
            <span
                className={cn(
                    'shrink-0 items-center gap-0.5',
                    hasPersistentAction
                        ? 'flex'
                        : 'hidden group-focus-within/tree-row:flex group-hover/tree-row:flex has-[[aria-busy=true]]:flex',
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
                        isRevealedOnHover={hasPersistentAction && !isPersistentAction(action)}
                        isTabStop={focusedCommandId === action.command.id}
                        key={action.command.id}
                    />
                ))}
            </span>
        </>
    );
}
