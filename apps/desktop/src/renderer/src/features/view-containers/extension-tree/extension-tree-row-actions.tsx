import type { FocusEvent, KeyboardEvent, RefObject } from 'react';
import { useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { cn } from '../../../lib/utilities';
import type { useTreeItemActionRunner } from '../hooks/use-tree-item-action-runner';
import type { TreeItemAction } from '../tree-item-actions';
import { treeItemActionKeyIntent } from '../tree-item-actions';
import { ExtensionTreeActionIcon } from './extension-tree-item-icon';
import { extensionTreeActionsHint } from './navigation';

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
    isRunning,
    isTabStop,
    onRun,
}: {
    action: TreeItemAction;
    /**
     * Set for a plain icon action sharing a group that stays visible because of a labeled or toned sibling.
     */
    isRevealedOnHover: boolean;
    /**
     * The row is running this action, started from this button or from the row's context menu.
     */
    isRunning: boolean;
    isTabStop: boolean;
    onRun: (action: TreeItemAction) => void;
}) {
    const isLabeled = action.label !== undefined;
    return (
        // A plain action's tooltip is hover only: the tree moves focus onto these buttons itself (Right from the row,
        // and the confirmation modal handing focus back), and a focus-opened tooltip that only repeats the accessible
        // name would pop up unasked. An action that explains its state (`tooltip`, a blocked merge's reason) also opens
        // on keyboard focus, because a keyboard user has no hover to discover why the button is colored; Escape still
        // returns to the row, which closes the popup with the focus that raised it.
        <Tooltip hoverOnly={!action.tooltip} content={action.tooltip ?? action.command.title}>
            <Button
                aria-label={actionAccessibleName(action)}
                aria-description={action.tooltip}
                aria-busy={isRunning || undefined}
                // `aria-disabled` rather than `disabled`: Chromium evicts focus from a button the moment it becomes
                // disabled, and the confirmation modal hands focus back to this button when it closes. A natively
                // disabled button would drop a keyboard user to the document body on Cancel.
                aria-disabled={isRunning || undefined}
                // 24px, the compact control height, inside the 28px row: a smaller target sits so close to the
                // clickable row that a near miss opens the pull request instead of merging it.
                className={cn(
                    'focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none',
                    isLabeled
                        ? cn(
                              'h-6 min-h-6 gap-1 px-1.5 text-[11px] font-medium enabled:not-aria-disabled:hover:brightness-125',
                              labeledActionToneClassNames[action.tone ?? 'neutral'],
                          )
                        : cn('size-6', action.tone && iconActionToneClassNames[action.tone]),
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
                    onRun(action);
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
    if (isImeComposing(event)) return;
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
    actionRunner,
    actions,
    descriptionId,
    isCollapsedBranch,
    rowElement,
}: {
    actionRunner: ReturnType<typeof useTreeItemActionRunner>;
    actions: TreeItemDto['actions'];
    /**
     * Whether Right on the row would expand it before reaching the actions, which changes the spoken key hint.
     */
    isCollapsedBranch: boolean;
    /**
     * Id of the visually hidden summary the row references through `aria-describedby`, so a screen reader hears that
     * the row has actions and how to reach them while the buttons themselves are still hidden.
     */
    descriptionId: string;
    rowElement: RefObject<HTMLDivElement | null>;
}) {
    const { t } = useTranslation();
    const [focusedCommandId, setFocusedCommandId] = useState<string>();
    if (!actions?.length) return null;
    const hasPersistentAction = actions.some(isPersistentAction);
    return (
        <>
            <span className="sr-only" id={descriptionId}>
                {extensionTreeActionsHint(actions, isCollapsedBranch, t)}
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
                        isRunning={actionRunner.runningCommandIds.has(action.command.id)}
                        isTabStop={focusedCommandId === action.command.id}
                        key={action.command.id}
                        onRun={actionRunner.runAction}
                    />
                ))}
            </span>
        </>
    );
}
