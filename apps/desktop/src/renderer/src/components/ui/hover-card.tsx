import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';

import { cn } from '@/lib/utilities';

import { ANCHORED_POPUP_MOTION } from './overlay-motion';

export function HoverCard(properties: PreviewCardPrimitive.Root.Props) {
    return <PreviewCardPrimitive.Root data-slot="hover-card" {...properties} />;
}

export function HoverCardTrigger(properties: PreviewCardPrimitive.Trigger.Props) {
    return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...properties} />;
}

export function HoverCardContent({
    className,
    side = 'bottom',
    sideOffset = 6,
    align = 'center',
    alignOffset,
    anchor,
    collisionAvoidance,
    collisionBoundary,
    collisionPadding,
    positionMethod,
    ...properties
}: PreviewCardPrimitive.Popup.Props &
    Pick<
        PreviewCardPrimitive.Positioner.Props,
        | 'align'
        | 'alignOffset'
        | 'anchor'
        | 'collisionAvoidance'
        | 'collisionBoundary'
        | 'collisionPadding'
        | 'positionMethod'
        | 'side'
        | 'sideOffset'
    >) {
    return (
        <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
            <PreviewCardPrimitive.Positioner
                align={align}
                alignOffset={alignOffset}
                anchor={anchor}
                collisionAvoidance={collisionAvoidance}
                collisionBoundary={collisionBoundary}
                collisionPadding={collisionPadding}
                positionMethod={positionMethod}
                side={side}
                sideOffset={sideOffset}
                className="z-[80] max-w-[var(--available-width)]"
            >
                <PreviewCardPrimitive.Popup
                    data-slot="hover-card-content"
                    className={cn(
                        'w-64 rounded-lg border border-border bg-elevated p-2.5 text-[13px] text-foreground shadow-[0_12px_32px_var(--shadow)] outline-none',
                        ANCHORED_POPUP_MOTION,
                        className,
                    )}
                    {...properties}
                />
            </PreviewCardPrimitive.Positioner>
        </PreviewCardPrimitive.Portal>
    );
}
