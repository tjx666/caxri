import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check } from 'lucide-react';

import { useModalRegistration } from '@/hooks/use-modal-registration';
import { cn } from '@/lib/utilities';

/**
 * Trigger-anchored dropdown menu. `context-menu.tsx` covers the right-click surface of the same Base UI Menu primitive;
 * both share one popup and item appearance so a pointer-anchored and a button-anchored menu never drift into two
 * different-looking menus.
 *
 * An open menu registers as a modal: Base UI already traps focus and blocks outside pointer interaction, so letting an
 * app-wide shortcut fire behind it would act on a surface the user cannot currently see or reach.
 */
export function Menu({ open, ...properties }: MenuPrimitive.Root.Props) {
    useModalRegistration(open);
    return <MenuPrimitive.Root open={open} {...properties} />;
}

export function MenuTrigger(properties: MenuPrimitive.Trigger.Props) {
    return <MenuPrimitive.Trigger data-slot="menu-trigger" {...properties} />;
}

export function MenuContent({
    align = 'start',
    className,
    collisionPadding = 8,
    side = 'bottom',
    sideOffset = 4,
    ...properties
}: MenuPrimitive.Popup.Props &
    Pick<MenuPrimitive.Positioner.Props, 'align' | 'collisionPadding' | 'side' | 'sideOffset'>) {
    return (
        <MenuPrimitive.Portal>
            <MenuPrimitive.Positioner
                align={align}
                className="z-[70]"
                collisionPadding={collisionPadding}
                side={side}
                sideOffset={sideOffset}
            >
                <MenuPrimitive.Popup
                    data-slot="menu-content"
                    className={cn(
                        // `--transform-origin` comes from `MenuPositionerCssVars` on the enclosing Positioner and
                        // inherits down to this popup, letting the zoom animation scale from the anchor edge.
                        'min-w-44 origin-(--transform-origin) rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        // `data-open`/`data-closed` (not `data-starting-style`/`data-ending-style`) persist for the
                        // whole enter/exit run, so gating the keyframe-based `animate-in`/`animate-out` utilities on
                        // them keeps the animation running to completion; Base UI keeps the popup mounted until
                        // `getAnimations()` reports nothing running.
                        'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                        'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                        // The keyframes are gated behind `motion-safe:` because a bare `motion-reduce:animate-none`
                        // (0,1,0) loses the specificity fight against `data-open:animate-in`'s attribute selector
                        // (0,2,0). Under reduced motion no animation runs, so `getAnimations()` reports nothing and
                        // close unmounts without waiting a frame.
                        className,
                    )}
                    {...properties}
                />
            </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
    );
}

export function MenuItem({ className, ...properties }: MenuPrimitive.Item.Props) {
    return (
        <MenuPrimitive.Item
            data-slot="menu-item"
            className={cn(
                'flex h-7 cursor-default items-center gap-2 rounded px-2 text-[12px] outline-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-[var(--selection)]',
                className,
            )}
            {...properties}
        />
    );
}

/**
 * A menu row that toggles a preference in place. It keeps the menu open (Base UI's default for checkbox items) so the
 * user sees the rest of the menu update before choosing an item; the check sits where an item's icon would.
 */
export function MenuCheckboxItem({
    children,
    className,
    ...properties
}: MenuPrimitive.CheckboxItem.Props) {
    return (
        <MenuPrimitive.CheckboxItem
            data-slot="menu-checkbox-item"
            className={cn(
                'flex h-7 cursor-default items-center gap-2 rounded px-2 text-[12px] outline-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-[var(--selection)]',
                className,
            )}
            {...properties}
        >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
                <MenuPrimitive.CheckboxItemIndicator>
                    <Check size={14} />
                </MenuPrimitive.CheckboxItemIndicator>
            </span>
            {children}
        </MenuPrimitive.CheckboxItem>
    );
}

export function MenuSeparator(properties: MenuPrimitive.Separator.Props) {
    return (
        <MenuPrimitive.Separator
            data-slot="menu-separator"
            className="my-1 h-px bg-border"
            {...properties}
        />
    );
}
