import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';

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

type HoverCardContentProperties = Omit<Parameters<typeof HoverCardContent>[0], 'children'>;

/**
 * What a {@link SharedHoverCard} trigger hands the shared Root it opens: everything its popup renders.
 */
interface HoverCardPayload {
    content: ReactNode;
    contentProps: HoverCardContentProperties;
}

type HoverCardHandle = PreviewCardPrimitive.Handle<HoverCardPayload>;

const HoverCardHandleContext = createContext<HoverCardHandle | undefined>(undefined);

/**
 * Mounts the one Root every {@link SharedHoverCard} below it opens. A long Agent Chat reply carries hundreds of link and
 * skill cards, and a Base UI Root per card kept about a fifth of the reply's retained heap (measured by `bun run
 * benchmark:chat-streaming`'s `richreply` workload); detached triggers keep only a Trigger each.
 */
export function HoverCardProvider({ children }: { children: ReactNode }) {
    const [handle] = useState(() => PreviewCardPrimitive.createHandle<HoverCardPayload>());
    return (
        <HoverCardHandleContext value={handle}>
            {children}
            <PreviewCardPrimitive.Root handle={handle}>
                {({ payload }) =>
                    payload && (
                        <HoverCardContent {...payload.contentProps}>
                            {/*
                             * A card inside this popup (a link in a skill's instructions) opens a Root of its own;
                             * sharing this one would replace the card the user is reading.
                             */}
                            <HoverCardHandleContext value={undefined}>
                                {payload.content}
                            </HoverCardHandleContext>
                        </HoverCardContent>
                    )
                }
            </PreviewCardPrimitive.Root>
        </HoverCardHandleContext>
    );
}

/**
 * An uncontrolled hover card whose popup the nearest {@link HoverCardProvider} renders, so a trigger costs no Root of
 * its own. Use it for a card that repeats with the content it sits in (a transcript's links and skills). `content`
 * renders outside the trigger's React tree and may only read app-wide context (translation, queries), so a card whose
 * content needs a narrower provider (a view container's) or whose open state the caller owns keeps the {@link HoverCard}
 * parts. Without a provider (a secondary window's root) it falls back to a Root of its own.
 */
export function SharedHoverCard({
    children,
    closeDelay,
    content,
    contentProps: contentProperties = {},
    delay,
    render,
}: {
    children?: ReactNode;
    closeDelay?: number;
    content: ReactNode;
    /**
     * The popup's placement and classes, as {@link HoverCardContent} takes them.
     */
    contentProps?: HoverCardContentProperties;
    delay?: number;
    render: ReactElement;
}) {
    const handle = useContext(HoverCardHandleContext);
    if (!handle)
        return (
            <HoverCard>
                <HoverCardTrigger closeDelay={closeDelay} delay={delay} render={render}>
                    {children}
                </HoverCardTrigger>
                <HoverCardContent {...contentProperties}>{content}</HoverCardContent>
            </HoverCard>
        );
    return (
        <PreviewCardPrimitive.Trigger
            closeDelay={closeDelay}
            data-slot="hover-card-trigger"
            delay={delay}
            handle={handle}
            payload={{ content, contentProps: contentProperties }}
            render={render}
        >
            {children}
        </PreviewCardPrimitive.Trigger>
    );
}
