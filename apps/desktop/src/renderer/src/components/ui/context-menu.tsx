import { useId, useState } from 'react';

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';

import { ShortcutBadge } from '@/components/shortcut-badge';
import { useModalRegistration } from '@/hooks/use-modal-registration';
import { cn } from '@/lib/utilities';

/**
 * Right-click surface of the same Base UI Menu primitive `menu.tsx` wraps; both share one popup and item appearance.
 *
 * An open context menu registers as a modal for the same reason a dropdown does: Base UI traps focus and blocks outside
 * pointer interaction, so an app-wide shortcut firing behind it would act on a surface the user cannot see or reach.
 * Unlike `Menu`, a context menu is almost always uncontrolled — it opens from a right click, not from consumer state —
 * so the open flag is mirrored here from `onOpenChange` instead of read off an `open` prop. A consumer's own
 * `onOpenChange` is chained, never replaced.
 */
export function ContextMenu({
    defaultOpen,
    onOpenChange,
    open,
    ...properties
}: ContextMenuPrimitive.Root.Props) {
    const [observedOpen, setObservedOpen] = useState(defaultOpen ?? false);
    useModalRegistration(open ?? observedOpen);
    return (
        <ContextMenuPrimitive.Root
            defaultOpen={defaultOpen}
            open={open}
            onOpenChange={(nextOpen, eventDetails) => {
                setObservedOpen(nextOpen);
                onOpenChange?.(nextOpen, eventDetails);
            }}
            {...properties}
        />
    );
}

export function ContextMenuTrigger(properties: ContextMenuPrimitive.Trigger.Props) {
    return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...properties} />;
}

export function ContextMenuContent({ className, ...properties }: ContextMenuPrimitive.Popup.Props) {
    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.Positioner className="z-[70]">
                <ContextMenuPrimitive.Popup
                    data-slot="context-menu-content"
                    className={cn(
                        // `ContextMenuPrimitive.Popup` is `MenuPopup` under the hood, so
                        // `--transform-origin` comes from `MenuPositionerCssVars` on the
                        // enclosing Positioner and inherits down to this popup, letting the
                        // zoom animation scale from the anchor edge like base-nova.
                        'min-w-40 origin-(--transform-origin) rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        // `data-open`/`data-closed` (not `data-starting-style`/
                        // `data-ending-style`) persist for the whole enter/exit run, so
                        // gating the keyframe-based `animate-in`/`animate-out` utilities on
                        // them keeps the animation running to completion; Base UI keeps the
                        // popup mounted until `getAnimations()` reports nothing running.
                        'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                        'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                        // The keyframes are gated behind `motion-safe:` because a bare
                        // `motion-reduce:animate-none` (0,1,0) loses the specificity fight
                        // against `data-open:animate-in`'s attribute selector (0,2,0). Under
                        // reduced motion no animation runs, so `getAnimations()` reports
                        // nothing and close unmounts without waiting a frame.
                        className,
                    )}
                    {...properties}
                />
            </ContextMenuPrimitive.Positioner>
        </ContextMenuPrimitive.Portal>
    );
}

export interface ContextMenuItemProperties extends ContextMenuPrimitive.Item.Props {
    /**
     * Accessible-only explanation for a disabled item (e.g. "Nothing to paste"). Screen readers announce it via
     * `aria-describedby`; sighted users get it from the native `title` tooltip.
     */
    disabledReason?: string;
    /**
     * Right-aligned live-keybinding hint, reusing the command palette's compact keycap chip.
     */
    hint?: string;
}

export function ContextMenuItem({
    children,
    className,
    disabledReason,
    hint,
    ...properties
}: ContextMenuItemProperties) {
    const generatedId = useId();
    const reasonId = disabledReason ? `context-menu-item-reason-${generatedId}` : undefined;
    return (
        <ContextMenuPrimitive.Item
            data-slot="context-menu-item"
            aria-describedby={reasonId}
            title={disabledReason}
            className={cn(
                'flex h-7 cursor-default items-center gap-2 rounded px-2 text-[12px] outline-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-[var(--selection)]',
                className,
            )}
            {...properties}
        >
            <span className="flex-1 truncate">{children}</span>
            {hint && <ShortcutBadge compact shortcut={hint} />}
            {reasonId && (
                <span id={reasonId} className="sr-only">
                    {disabledReason}
                </span>
            )}
        </ContextMenuPrimitive.Item>
    );
}

export function ContextMenuSeparator(properties: ContextMenuPrimitive.Separator.Props) {
    return (
        <ContextMenuPrimitive.Separator
            data-slot="context-menu-separator"
            className="my-1 h-px bg-border"
            {...properties}
        />
    );
}
