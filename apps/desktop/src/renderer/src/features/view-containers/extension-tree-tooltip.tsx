import type {
    FocusEventHandler,
    KeyboardEventHandler,
    PointerEvent as ReactPointerEvent,
    ReactElement,
} from 'react';
import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import type { TooltipCursorAnchor } from '../../components/tooltip-positioning';
import {
    resolveTooltipCursorAnchor,
    TOOLTIP_CURSOR_COLLISION_PADDING,
    TOOLTIP_CURSOR_SIDE_OFFSET,
} from '../../components/tooltip-positioning';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { ExtensionTreeTooltipMarkdown } from './extension-tree-tooltip-markdown';

type RichTooltip = Exclude<TreeItemDto['tooltip'], string | undefined>;

const badgeToneClassNames: Record<NonNullable<RichTooltip['badge']>['tone'], string> = {
    danger: 'text-danger',
    neutral: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

const HOVER_OPEN_DELAY_MS = 500;

function isRowActionTarget(target: EventTarget): boolean {
    return target instanceof Element && target.closest('[data-tree-item-actions]') !== null;
}

function openTooltipUrl(url: string): void {
    void openExternalUrl(url, (message) => pushToast('error', message));
}

export function ExtensionTreeTooltip({
    tooltip,
    trigger,
}: {
    tooltip: RichTooltip;
    trigger: ReactElement<Record<string, unknown>>;
}) {
    const latestPointer = useRef<{ x: number; y: number }>(undefined);
    const isPointerOnRowAction = useRef(false);
    const reopenTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const popupReference = useRef<HTMLDivElement>(null);
    const triggerReference = useRef<HTMLAnchorElement>(null);
    const tooltipId = useId();
    const { t } = useTranslation();
    const [cursorAnchor, setCursorAnchor] = useState<TooltipCursorAnchor>();
    const [open, setOpen] = useState(false);
    const triggerFocus = trigger.props.onFocus as FocusEventHandler<HTMLElement> | undefined;
    const triggerKeyDown = trigger.props.onKeyDown as KeyboardEventHandler<HTMLElement> | undefined;
    const handleTriggerFocus = useCallback<FocusEventHandler<HTMLElement>>(
        (event) => {
            triggerFocus?.(event);
            if (event.defaultPrevented) return;
            /**
             * Disclosure clicks focus the row too. Match Base UI's keyboard-focus gate so those clicks do not replace a
             * hover anchor with the row's bottom edge or open a card before the hover delay.
             */
            if (!event.currentTarget.matches(':focus-visible')) return;
            setCursorAnchor(undefined);
            setOpen(true);
        },
        [triggerFocus],
    );
    const handleTriggerKeyDown = useCallback<KeyboardEventHandler<HTMLElement>>(
        (event) => {
            triggerKeyDown?.(event);
            if (event.defaultPrevented || event.key !== 'Tab' || event.shiftKey) return;
            const firstLink = document.querySelector<HTMLButtonElement>(
                `#${CSS.escape(tooltipId)} button:not(:disabled)`,
            );
            if (!firstLink) return;
            event.preventDefault();
            firstLink.focus();
        },
        [tooltipId, triggerKeyDown],
    );
    /**
     * Seeds the pointer before Base UI's mouse-enter open path, then keeps it current during the cold-open delay.
     */
    const capturePointer = useCallback((event: ReactPointerEvent) => {
        latestPointer.current = { x: event.clientX, y: event.clientY };
        const wasOnRowAction = isPointerOnRowAction.current;
        isPointerOnRowAction.current = isRowActionTarget(event.target);
        if (isPointerOnRowAction.current) {
            /**
             * An inline action (Merge) has its own tooltip; the row's card would cover the rows below it and compete
             * with that tooltip, so moving onto an action closes a card the row itself raised.
             */
            clearTimeout(reopenTimer.current);
            setOpen(false);
            return;
        }
        if (!wasOnRowAction) return;
        /**
         * Base UI starts its hover delay only when the pointer enters the row, and the open cancelled over the action
         * used it up. Returning to the row body restarts the same delay here, so the card still opens without leaving
         * and re-entering the row.
         */
        clearTimeout(reopenTimer.current);
        reopenTimer.current = setTimeout(() => {
            setCursorAnchor(
                resolveTooltipCursorAnchor(true, 'trigger-hover', latestPointer.current),
            );
            setOpen(true);
        }, HOVER_OPEN_DELAY_MS);
    }, []);
    const handlePointerLeave = useCallback(() => {
        isPointerOnRowAction.current = false;
        clearTimeout(reopenTimer.current);
    }, []);
    useEffect(() => () => clearTimeout(reopenTimer.current), []);
    /**
     * Base UI gives the rendered element's props precedence over Trigger props. Compose focus opening and the Tab
     * bridge into the tree row so its roving-focus handlers remain active and keyboard users can enter the links.
     */
    const keyboardTrigger = cloneElement(trigger, {
        onFocus: handleTriggerFocus,
        onKeyDown: handleTriggerKeyDown,
    });
    /**
     * A rich popup must stay beside the pointer. Shifting a bottom-placed popup back across the pointer in a narrow
     * Status panel would cover the following rows and prevent straight downward navigation.
     */
    const side = cursorAnchor ? 'right' : 'bottom';
    return (
        <HoverCard
            open={open}
            onOpenChange={(nextOpen, details) => {
                /**
                 * The hover delay started on the row may expire while the pointer rests on an inline action; that
                 * action's own tooltip is the one the user asked for.
                 */
                if (
                    nextOpen &&
                    details.reason === 'trigger-hover' &&
                    isPointerOnRowAction.current
                ) {
                    details.cancel();
                    return;
                }
                /**
                 * PreviewCard closes a focus-opened popup when its trigger blurs, even when the next focus target is
                 * inside the popup. The explicit Tab bridge below moves focus synchronously, so retain the controlled
                 * popup for that one transition while preserving Escape and outside-press dismissal.
                 */
                if (
                    !nextOpen &&
                    details.reason === 'trigger-focus' &&
                    popupReference.current?.contains(document.activeElement)
                )
                    return;
                setOpen(nextOpen);
                if (!nextOpen) return;
                setCursorAnchor(
                    resolveTooltipCursorAnchor(nextOpen, details.reason, latestPointer.current),
                );
            }}
            onOpenChangeComplete={(open) => {
                if (!open) setCursorAnchor(undefined);
            }}
        >
            <HoverCardTrigger
                closeDelay={120}
                delay={HOVER_OPEN_DELAY_MS}
                ref={triggerReference}
                render={keyboardTrigger}
                onPointerEnter={capturePointer}
                onPointerLeave={handlePointerLeave}
                onPointerMove={capturePointer}
            />
            <HoverCardContent
                align="start"
                anchor={cursorAnchor}
                className="tree-item-rich-tooltip w-auto max-w-[min(23rem,calc(100vw-16px))] p-3"
                collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'none', side: 'flip' }}
                collisionBoundary={document.documentElement}
                collisionPadding={TOOLTIP_CURSOR_COLLISION_PADDING}
                id={tooltipId}
                positionMethod="fixed"
                ref={popupReference}
                role="dialog"
                side={side}
                sideOffset={cursorAnchor ? TOOLTIP_CURSOR_SIDE_OFFSET : 6}
                aria-label={`${tooltip.title} details`}
                onKeyDown={(event) => {
                    if (event.key !== 'Tab' || !event.shiftKey) return;
                    const firstLink =
                        popupReference.current?.querySelector<HTMLButtonElement>(
                            'button:not(:disabled)',
                        );
                    if (event.target !== firstLink) return;
                    event.preventDefault();
                    triggerReference.current?.focus();
                }}
                onBlurCapture={() => {
                    queueMicrotask(() => {
                        if (popupReference.current?.contains(document.activeElement)) return;
                        if (triggerReference.current?.contains(document.activeElement)) return;
                        setOpen(false);
                    });
                }}
                onFocusCapture={() => setOpen(true)}
            >
                {/*
                 * A title can be a full pull request title or provider error, so the heading wraps and the badge wraps
                 * with it instead of pinning a tall chip beside a multi-line title.
                 */}
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[13px] leading-5">
                    <strong className="font-semibold wrap-anywhere">{tooltip.title}</strong>
                    {tooltip.badge && (
                        <>
                            <span className="text-muted">·</span>
                            <code
                                className={cn(
                                    'rounded bg-surface px-1.5 py-0.5 text-[12px] font-semibold',
                                    badgeToneClassNames[tooltip.badge.tone],
                                )}
                            >
                                {tooltip.badge.label}
                            </code>
                        </>
                    )}
                </div>
                {tooltip.description && (
                    <p className="mt-1 mb-0 text-[12px] leading-5 wrap-anywhere text-muted">
                        {tooltip.description}
                    </p>
                )}
                {tooltip.markdown && (
                    <ExtensionTreeTooltipMarkdown
                        source={tooltip.markdown}
                        onOpenUrl={openTooltipUrl}
                    />
                )}
                {tooltip.rows.length > 0 && (
                    <ul className="mt-2 mb-0 list-disc space-y-1 pl-5 text-[12px] leading-5">
                        {tooltip.rows.map((row) => (
                            <li
                                className="min-w-0"
                                key={`${row.label}\0${row.value}\0${row.url ?? ''}`}
                            >
                                <span className="text-muted">{row.label}: </span>
                                {row.url ? (
                                    <button
                                        aria-label={t(
                                            'viewContainers.extensionTree.openTooltipLink',
                                            {
                                                label: row.label,
                                                value: row.value,
                                            },
                                        )}
                                        className="max-w-full cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                                        type="button"
                                        onClick={() => openTooltipUrl(row.url!)}
                                    >
                                        <span className="wrap-anywhere">{row.value}</span>
                                    </button>
                                ) : (
                                    <span className="wrap-anywhere text-foreground">
                                        {row.value}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}
