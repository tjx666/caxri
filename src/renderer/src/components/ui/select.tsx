import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export function Select<Value>(props: SelectPrimitive.Root.Props<Value>) {
    return <SelectPrimitive.Root {...props} />;
}

export function SelectValue(props: SelectPrimitive.Value.Props) {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            className={cn(
                'flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
                className,
            )}
            {...props}
        >
            {children}
            <SelectPrimitive.Icon render={<ChevronDown aria-hidden="true" size={14} />} />
        </SelectPrimitive.Trigger>
    );
}

export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Positioner sideOffset={4} className="z-60">
                <SelectPrimitive.Popup
                    data-slot="select-content"
                    className={cn(
                        'max-h-(--available-height) min-w-(--anchor-width) overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10',
                        className,
                    )}
                    {...props}
                >
                    <SelectPrimitive.List>{children}</SelectPrimitive.List>
                </SelectPrimitive.Popup>
            </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
    );
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
    return (
        <SelectPrimitive.Item
            data-slot="select-item"
            className={cn(
                'relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
                className,
            )}
            {...props}
        >
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="absolute right-2 grid size-4 place-items-center">
                <Check aria-hidden="true" size={13} />
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}
