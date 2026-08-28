import type { FocusEventHandler, KeyboardEventHandler, ReactElement } from 'react';
import { cloneElement, useCallback, useId, useRef, useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import type { TooltipCursorAnchor } from '../../components/tooltip-positioning';
import {
    resolveTooltipCursorAnchor,
    TOOLTIP_CURSOR_COLLISION_PADDING,
} from '../../components/tooltip-positioning';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';

type RichTooltip = Exclude<TreeItemDto['tooltip'], string | undefined>;

const badgeToneClassNames: Record<NonNullable<RichTooltip['badge']>['tone'], string> = {
    danger: 'text-danger',
    neutral: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

function openTooltipUrl(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports failures through the shared toast path.
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
    const popupReference = useRef<HTMLDivElement>(null);
    const triggerReference = useRef<HTMLAnchorElement>(null);
    const tooltipId = useId();
    const [cursorAnchor, setCursorAnchor] = useState<TooltipCursorAnchor>();
    const [open, setOpen] = useState(false);
    const triggerFocus = trigger.props.onFocus as FocusEventHandler<HTMLElement> | undefined;
    const triggerKeyDown = trigger.props.onKeyDown as KeyboardEventHandler<HTMLElement> | undefined;
    const handleTriggerFocus = useCallback<FocusEventHandler<HTMLElement>>(
        (event) => {
            triggerFocus?.(event);
            if (event.defaultPrevented) return;
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
     * Base UI gives the rendered element's props precedence over Trigger props. Compose focus opening and the Tab
     * bridge into the tree row so its roving-focus handlers remain active and keyboard users can enter the links.
     */
    const keyboardTrigger = cloneElement(trigger, {
        onFocus: handleTriggerFocus,
        onKeyDown: handleTriggerKeyDown,
    });
    return (
        <HoverCard
            open={open}
            onOpenChange={(nextOpen, details) => {
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
                    resolveTooltipCursorAnchor(
                        nextOpen,
                        details.reason,
                        latestPointer.current,
                        document.documentElement.clientWidth,
                    ),
                );
            }}
            onOpenChangeComplete={(open) => {
                if (!open) setCursorAnchor(undefined);
            }}
        >
            <HoverCardTrigger
                closeDelay={120}
                delay={500}
                ref={triggerReference}
                render={keyboardTrigger}
                onPointerMove={(event) => {
                    latestPointer.current = { x: event.clientX, y: event.clientY };
                }}
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
                side="bottom"
                sideOffset={cursorAnchor ? 8 : 6}
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
                <div className="flex items-center gap-1.5 text-[13px] leading-none">
                    <strong className="font-semibold">{tooltip.title}</strong>
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
                <ul className="mt-2 mb-0 list-disc space-y-1 pl-5 text-[12px] leading-5">
                    {tooltip.rows.map((row, index) => (
                        <li className="min-w-0" key={`${row.label}:${index}`}>
                            <span className="text-muted">{row.label}: </span>
                            {row.url ? (
                                <button
                                    aria-label={`Open ${row.label}: ${row.value}`}
                                    className="max-w-full cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                                    type="button"
                                    onClick={() => openTooltipUrl(row.url!)}
                                >
                                    <span className="wrap-anywhere">{row.value}</span>
                                </button>
                            ) : (
                                <span className="wrap-anywhere text-foreground">{row.value}</span>
                            )}
                        </li>
                    ))}
                </ul>
            </HoverCardContent>
        </HoverCard>
    );
}
