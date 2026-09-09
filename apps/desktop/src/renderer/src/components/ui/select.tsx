import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utilities';

export function Select<Value>(properties: SelectPrimitive.Root.Props<Value>) {
    return <SelectPrimitive.Root {...properties} />;
}

export function SelectValue(properties: SelectPrimitive.Value.Props) {
    return <SelectPrimitive.Value data-slot="select-value" {...properties} />;
}

export function SelectTrigger({
    className,
    children,
    showIcon = true,
    ...properties
}: SelectPrimitive.Trigger.Props & { showIcon?: boolean }) {
    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            className={cn(
                'flex h-9 w-full items-center justify-between gap-2 rounded border border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)] px-2 text-[13px] text-inherit transition-[border-color,box-shadow,background-color] duration-150 ease-out outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 [&>[data-slot=select-value]]:min-w-0 [&>[data-slot=select-value]]:overflow-hidden [&>[data-slot=select-value]]:text-ellipsis [&>[data-slot=select-value]]:whitespace-nowrap [&>svg]:flex-none',
                className,
            )}
            {...properties}
        >
            {children}
            {showIcon && (
                <SelectPrimitive.Icon render={<ChevronDown aria-hidden="true" size={14} />} />
            )}
        </SelectPrimitive.Trigger>
    );
}

export function SelectContent({ className, children, ...properties }: SelectPrimitive.Popup.Props) {
    return (
        <SelectPrimitive.Portal>
            {/**
             * Base UI defaults `alignItemWithTrigger` to true, which overlays the popup on the trigger (macOS-native style) and
             * ignores `side`/`align` and `--available-height`. With long lists (e.g. the status-bar branch picker) that mode fills
             * the window and spills past the viewport, so every Select uses regular popover positioning.
             */}
            <SelectPrimitive.Positioner
                alignItemWithTrigger={false}
                sideOffset={4}
                className="z-[60]"
            >
                <SelectPrimitive.Popup
                    data-slot="select-content"
                    className={cn(
                        // `--transform-origin` is set by `SelectPositioner` (see
                        // `SelectPositionerCssVars`) and inherits down to this popup, so
                        // the zoom animation below scales from the anchor edge like
                        // base-nova instead of the popup's geometric center.
                        'max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-auto rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]',
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
                >
                    <SelectPrimitive.List>{children}</SelectPrimitive.List>
                </SelectPrimitive.Popup>
            </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
    );
}

export function SelectItem({ className, children, ...properties }: SelectPrimitive.Item.Props) {
    return (
        <SelectPrimitive.Item
            data-slot="select-item"
            className={cn(
                'relative flex min-h-7 cursor-default items-center rounded py-1 pr-6 pl-2 text-[13px] outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-[var(--selection)] data-highlighted:text-foreground',
                className,
            )}
            {...properties}
        >
            <SelectPrimitive.ItemText className="min-w-0 wrap-anywhere">
                {children}
            </SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="absolute right-2 grid size-4 place-items-center">
                <Check aria-hidden="true" size={13} />
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}
