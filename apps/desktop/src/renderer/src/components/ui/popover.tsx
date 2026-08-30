import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

import { cn } from '@/lib/utilities';

export type PopoverActions = PopoverPrimitive.Root.Actions;

export function Popover<Payload>(properties: PopoverPrimitive.Root.Props<Payload>) {
    return <PopoverPrimitive.Root {...properties} />;
}

export function PopoverTrigger<Payload>(properties: PopoverPrimitive.Trigger.Props<Payload>) {
    return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...properties} />;
}

export function PopoverContent({
    align = 'start',
    className,
    collisionPadding = 8,
    side = 'bottom',
    sideOffset = 4,
    ...properties
}: PopoverPrimitive.Popup.Props &
    Pick<PopoverPrimitive.Positioner.Props, 'align' | 'collisionPadding' | 'side' | 'sideOffset'>) {
    return (
        <PopoverPrimitive.Portal data-slot="popover-portal">
            <PopoverPrimitive.Positioner
                align={align}
                collisionPadding={collisionPadding}
                side={side}
                sideOffset={sideOffset}
                className="z-[80] max-w-[var(--available-width)]"
            >
                <PopoverPrimitive.Popup
                    data-slot="popover-content"
                    className={cn(
                        'w-72 origin-(--transform-origin) overflow-hidden rounded-md bg-elevated text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                        'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                        className,
                    )}
                    {...properties}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}
