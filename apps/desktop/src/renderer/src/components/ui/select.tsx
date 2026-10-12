import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utilities';

import { ANCHORED_POPUP_MOTION } from './overlay-motion';

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
                'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)] px-2 text-[13px] text-inherit transition-[border-color,box-shadow,background-color] outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 [&>[data-slot=select-value]]:min-w-0 [&>[data-slot=select-value]]:overflow-hidden [&>[data-slot=select-value]]:text-ellipsis [&>[data-slot=select-value]]:whitespace-nowrap [&>svg]:flex-none',
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
                        'max-h-(--available-height) min-w-(--anchor-width) overflow-auto rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]',
                        ANCHORED_POPUP_MOTION,
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
