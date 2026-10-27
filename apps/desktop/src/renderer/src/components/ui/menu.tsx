import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check } from 'lucide-react';

import { useModalRegistration } from '@/hooks/use-modal-registration';
import { cn } from '@/lib/utilities';

import { ANCHORED_POPUP_MOTION } from './overlay-motion';

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
    alignOffset,
    className,
    collisionPadding = 8,
    side = 'bottom',
    sideOffset = 4,
    ...properties
}: MenuPrimitive.Popup.Props &
    Pick<
        MenuPrimitive.Positioner.Props,
        'align' | 'alignOffset' | 'collisionPadding' | 'side' | 'sideOffset'
    >) {
    return (
        <MenuPrimitive.Portal>
            <MenuPrimitive.Positioner
                align={align}
                alignOffset={alignOffset}
                className="z-[70]"
                collisionPadding={collisionPadding}
                side={side}
                sideOffset={sideOffset}
            >
                <MenuPrimitive.Popup
                    data-slot="menu-content"
                    className={cn(
                        'min-w-44 rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        ANCHORED_POPUP_MOTION,
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
 * user sees the rest of the menu update before choosing an item. The check trails the row, as macOS menus and the Codex
 * app place it, so a row's leading icon and label stay where every other row's are.
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
            {children}
            <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center text-muted">
                <MenuPrimitive.CheckboxItemIndicator>
                    <Check size={14} />
                </MenuPrimitive.CheckboxItemIndicator>
            </span>
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

export function MenuGroup(properties: MenuPrimitive.Group.Props) {
    return <MenuPrimitive.Group data-slot="menu-group" {...properties} />;
}

export function MenuGroupLabel({ className, ...properties }: MenuPrimitive.GroupLabel.Props) {
    return (
        <MenuPrimitive.GroupLabel
            data-slot="menu-group-label"
            className={cn('px-2 pt-1 pb-0.5 text-[11px] text-muted', className)}
            {...properties}
        />
    );
}

export function MenuRadioGroup(properties: MenuPrimitive.RadioGroup.Props) {
    return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...properties} />;
}

/**
 * One choice of a {@link MenuRadioGroup}, laid out like {@link MenuCheckboxItem} so a menu mixing both keeps one trailing
 * column for its checks.
 */
export function MenuRadioItem({
    children,
    className,
    ...properties
}: MenuPrimitive.RadioItem.Props) {
    return (
        <MenuPrimitive.RadioItem
            data-slot="menu-radio-item"
            className={cn(
                'flex min-h-7 cursor-default items-center gap-2 rounded px-2 py-1 text-[12px] outline-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-[var(--selection)]',
                className,
            )}
            {...properties}
        >
            {children}
            <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center text-muted">
                <MenuPrimitive.RadioItemIndicator>
                    <Check size={14} />
                </MenuPrimitive.RadioItemIndicator>
            </span>
        </MenuPrimitive.RadioItem>
    );
}
