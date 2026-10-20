import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

import { cn } from '@/lib/utilities';

import { ANCHORED_POPUP_MOTION } from './overlay-motion';

export function Popover<Payload>(properties: PopoverPrimitive.Root.Props<Payload>) {
    return <PopoverPrimitive.Root {...properties} />;
}

export function PopoverTrigger<Payload>(properties: PopoverPrimitive.Trigger.Props<Payload>) {
    return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...properties} />;
}

export function PopoverContent({
    align = 'start',
    anchor,
    className,
    collisionPadding = 8,
    side = 'bottom',
    sideOffset = 4,
    ...properties
}: PopoverPrimitive.Popup.Props &
    Pick<
        PopoverPrimitive.Positioner.Props,
        'align' | 'anchor' | 'collisionPadding' | 'side' | 'sideOffset'
    >) {
    return (
        <PopoverPrimitive.Portal data-slot="popover-portal">
            <PopoverPrimitive.Positioner
                align={align}
                anchor={anchor}
                collisionPadding={collisionPadding}
                side={side}
                sideOffset={sideOffset}
                className="z-[80] max-w-[var(--available-width)]"
            >
                <PopoverPrimitive.Popup
                    data-slot="popover-content"
                    className={cn(
                        'w-72 overflow-hidden rounded-md bg-elevated text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        ANCHORED_POPUP_MOTION,
                        className,
                    )}
                    {...properties}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}
