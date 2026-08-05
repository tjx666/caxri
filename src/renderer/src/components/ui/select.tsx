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
            className={cn('select-trigger', className)}
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
            <SelectPrimitive.Positioner sideOffset={4} className="select-positioner">
                <SelectPrimitive.Popup
                    data-slot="select-content"
                    className={cn('select-content', className)}
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
            className={cn('select-item', className)}
            {...props}
        >
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="select-item-indicator">
                <Check aria-hidden="true" size={13} />
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}
