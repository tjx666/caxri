import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';

import { cn } from '@/lib/utilities';

import type { ToggleProperties } from './toggle';
import { Toggle } from './toggle';

export function ToggleGroup<Value extends string = string>({
    className,
    ...properties
}: ToggleGroupPrimitive.Props<Value>) {
    return (
        <ToggleGroupPrimitive
            data-slot="toggle-group"
            className={cn('inline-flex items-center gap-1', className)}
            {...properties}
        />
    );
}

export function ToggleGroupItem<Value extends string = string>({
    className,
    size,
    ...properties
}: ToggleProperties<Value>) {
    return (
        <Toggle
            data-slot="toggle-group-item"
            className={cn(className)}
            size={size}
            {...properties}
        />
    );
}
