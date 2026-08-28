import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';

import { cn } from '@/lib/utilities';

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
                        'w-64 origin-(--transform-origin) rounded-lg border border-border bg-elevated p-2.5 text-[13px] text-foreground shadow-[0_12px_32px_var(--shadow)] outline-none',
                        // Same keyframe-based `animate-in`/`animate-out` pattern documented in
                        // `tooltip.tsx`: gating on `data-open`/`data-closed` (which persist for
                        // the whole enter/exit run, unlike the one-frame starting/ending-style
                        // attributes) keeps the animation running to completion, and Base UI
                        // keeps the popup mounted until `getAnimations()` reports nothing running.
                        'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                        'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                        // Gated behind `motion-safe:` (not a bare `motion-reduce:animate-none`)
                        // for the same specificity reason as `tooltip.tsx`: `motion-reduce:` has
                        // lower specificity than `data-open:animate-in`'s attribute selector.
                        className,
                    )}
                    {...properties}
                />
            </PreviewCardPrimitive.Positioner>
        </PreviewCardPrimitive.Portal>
    );
}
