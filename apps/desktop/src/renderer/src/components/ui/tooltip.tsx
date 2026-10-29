import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

import { cn } from '../../lib/utilities';
import { ShortcutBadge } from '../shortcut-badge';
import type { TooltipCursorAnchor } from '../tooltip-positioning';
import {
    resolveTooltipCursorAnchor,
    TOOLTIP_CURSOR_COLLISION_PADDING,
    TOOLTIP_CURSOR_SIDE_OFFSET,
} from '../tooltip-positioning';
import { TOOLTIP_MOTION } from './overlay-motion';

/**
 * Classes for a non-interactive element that is made a keyboard tab stop (`tabIndex={0}`) only so its {@link Tooltip}
 * opens on focus. A native `title` never shows on focus, so truncated or unique text moves to the shared Tooltip on a
 * focusable trigger; this gives that trigger a visible focus ring.
 */
export const FOCUSABLE_TOOLTIP_TRIGGER_CLASS =
    'rounded-sm focus-visible:outline focus-visible:outline-accent';

type TooltipSide = 'bottom' | 'left' | 'right' | 'top';

/**
 * What a trigger hands the shared Root it opens: everything the popup renders, so one Root serves every trigger of its
 * variant instead of each trigger carrying its own Root, store, and hook state.
 */
interface TooltipPayload {
    content: ReactNode;
    shortcut: string | undefined;
    side: TooltipSide;
}

interface PointerPosition {
    x: number;
    y: number;
}

/**
 * Mutable cell for the latest pointer position; a plain object so a React Compiler lint does not read the context value
 * it lives in as mutated.
 */
interface TooltipPointer {
    position: PointerPosition | undefined;
}

type TooltipHandle = TooltipPrimitive.Handle<TooltipPayload>;

/**
 * A long Agent Chat reply mounts hundreds of Tooltips (every code block toolbar, table, inline path, and link), and a
 * Base UI Root per Tooltip kept about a third of the reply's retained heap. Triggers are therefore detached from the
 * Root: the {@link TooltipProvider} mounts one Root per variant, and each {@link Tooltip} only renders a Trigger bound to
 * that variant's handle.
 */
interface TooltipHosts {
    /**
     * Pointer-anchored popups (tree rows); the anchor state lives in this variant's single Root.
     */
    cursor: TooltipHandle;
    /**
     * Element-anchored popups.
     */
    element: TooltipHandle;
    /**
     * Element-anchored popups that ignore keyboard focus.
     */
    hoverOnly: TooltipHandle;
    /**
     * The latest pointer position over any cursor-anchored trigger.
     */
    pointer: TooltipPointer;
}

const TooltipHostsContext = createContext<TooltipHosts | undefined>(undefined);

export function TooltipProvider({ children }: { children: ReactNode }) {
    const [hosts] = useState<TooltipHosts>(() => {
        return {
            cursor: TooltipPrimitive.createHandle<TooltipPayload>(),
            element: TooltipPrimitive.createHandle<TooltipPayload>(),
            hoverOnly: TooltipPrimitive.createHandle<TooltipPayload>(),
            pointer: { position: undefined },
        };
    });
    return (
        <TooltipPrimitive.Provider delay={500} closeDelay={80} timeout={300}>
            <TooltipHostsContext value={hosts}>
                {children}
                <TooltipHost handle={hosts.element} />
                <TooltipHost handle={hosts.hoverOnly} hoverOnly />
                <CursorTooltipHost handle={hosts.cursor} pointer={hosts.pointer} />
            </TooltipHostsContext>
        </TooltipPrimitive.Provider>
    );
}

function TooltipPopup({ payload }: { payload: TooltipPayload }) {
    return (
        <TooltipPrimitive.Popup
            className={cn(
                // Kept as a plain class (not `data-slot`) because E2E reads a tooltip's rendered text
                // through `.tooltip-popup` (`e2e/statusbar.e2e.ts`, `e2e/editor-git-actions.e2e.ts`).
                'tooltip-popup flex max-w-80 items-center gap-3 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                TOOLTIP_MOTION,
            )}
        >
            <span className="min-w-0 wrap-anywhere whitespace-pre-line">{payload.content}</span>
            {payload.shortcut && (
                <ShortcutBadge className="ml-auto" compact shortcut={payload.shortcut} />
            )}
        </TooltipPrimitive.Popup>
    );
}

/*
 * Base UI marks the positioner `data-anchor-hidden` once a clipping ancestor (a scrolled list) hides the trigger, but
 * keeps rendering the popup beside it. A wheel scroll leaves the pointer still, so no pointer-leave closes the tooltip
 * either; hiding it here keeps it from floating outside the list.
 */
const POSITIONER_CLASS = 'z-[90] max-w-[var(--available-width)] data-[anchor-hidden]:invisible';

function TooltipHost({ handle, hoverOnly }: { handle: TooltipHandle; hoverOnly?: boolean }) {
    return (
        <TooltipPrimitive.Root
            handle={handle}
            onOpenChange={
                hoverOnly
                    ? (open, details) => {
                          /**
                           * Base UI calls this before it commits the open, and honors `cancel()` by dropping the change
                           * entirely, so the popup never mounts rather than mounting and being closed again.
                           */
                          if (open && details.reason === 'trigger-focus') details.cancel();
                      }
                    : undefined
            }
        >
            {({ payload }) =>
                payload && (
                    <TooltipPrimitive.Portal>
                        <TooltipPrimitive.Positioner
                            className={POSITIONER_CLASS}
                            side={payload.side}
                            sideOffset={6}
                        >
                            <TooltipPopup payload={payload} />
                        </TooltipPrimitive.Positioner>
                    </TooltipPrimitive.Portal>
                )
            }
        </TooltipPrimitive.Root>
    );
}

function CursorTooltipHost({
    handle,
    pointer,
}: {
    handle: TooltipHandle;
    pointer: TooltipPointer;
}) {
    const [cursorAnchor, setCursorAnchor] = useState<TooltipCursorAnchor>();
    /*
     * The collision middleware is installed unconditionally, before the first popup mount: the hover-open callback sets
     * the anchor asynchronously, and waiting for that state would let a first right-edge open use Base UI's default
     * flip behavior and overflow by the cursor offset.
     */
    return (
        <TooltipPrimitive.Root
            handle={handle}
            onOpenChange={(open, details) => {
                if (open) {
                    setCursorAnchor(
                        resolveTooltipCursorAnchor(open, details.reason, pointer.position),
                    );
                }
            }}
            onOpenChangeComplete={(open) => {
                if (!open) setCursorAnchor(undefined);
            }}
        >
            {({ payload }) =>
                payload && (
                    <TooltipPrimitive.Portal>
                        <TooltipPrimitive.Positioner
                            align={cursorAnchor ? 'start' : undefined}
                            anchor={cursorAnchor}
                            className={POSITIONER_CLASS}
                            collisionAvoidance={{
                                side: 'flip',
                                align: 'shift',
                                fallbackAxisSide: 'none',
                            }}
                            collisionPadding={TOOLTIP_CURSOR_COLLISION_PADDING}
                            positionMethod={cursorAnchor ? 'fixed' : undefined}
                            /*
                             * Keeps the popup beside the pointer so its vertical path through adjacent tree rows stays
                             * clear. Floating UI flips the popup to the left near the right edge without moving it
                             * across that path.
                             */
                            side={cursorAnchor ? 'right' : payload.side}
                            sideOffset={cursorAnchor ? TOOLTIP_CURSOR_SIDE_OFFSET : 6}
                        >
                            <TooltipPopup payload={payload} />
                        </TooltipPrimitive.Positioner>
                    </TooltipPrimitive.Portal>
                )
            }
        </TooltipPrimitive.Root>
    );
}

function rememberPointer(pointer: TooltipPointer, event: ReactPointerEvent): void {
    pointer.position = { x: event.clientX, y: event.clientY };
}

export function Tooltip({
    anchorMode = 'element',
    children,
    content,
    disabled,
    hoverOnly,
    shortcut,
    side = 'bottom',
    triggerId,
}: {
    /**
     * Uses the pointer position captured when the tooltip opens; the default remains element-centered.
     */
    anchorMode?: 'cursor' | 'element';
    children: ReactElement;
    content: ReactNode;
    /**
     * Keeps the trigger (and the `triggerId` it owns) mounted while suppressing the popup, for a caller whose tooltip
     * is only worth showing under a condition that changes at runtime.
     */
    disabled?: boolean;
    /**
     * Drops Base UI's keyboard-focus open, leaving the pointer as the only way to raise this tooltip.
     *
     * For a trigger the app itself focuses, a focus-opened tooltip is a popup the user never asked for and nothing
     * dismisses: it sits over whatever is below the trigger until the next interaction. Use it only where the tooltip's
     * text is already in the trigger's accessible name, so a screen reader still hears it.
     */
    hoverOnly?: boolean;
    shortcut?: string;
    /**
     * The trigger edge an element-anchored tooltip opens from; a cursor-anchored one always sits beside the pointer.
     */
    side?: TooltipSide;
    /**
     * Required when the trigger element needs an `id` of its own (a WAI-ARIA `role="tab"`, for example).
     *
     * Base UI writes its generated trigger id onto the rendered element, but merges the element's own props last, so a
     * plain `id` on the child silently wins, and the tooltip store is then keyed to an id no element carries, leaving
     * the tooltip permanently closed. Passing the id here makes the store and the DOM agree; the child must not also
     * set one.
     */
    triggerId?: string;
}) {
    const hosts = useContext(TooltipHostsContext);
    /**
     * Stable while its parts are: Base UI copies the payload into the shared store, and a fresh object per render would
     * re-render the open popup's Root for every trigger that re-renders.
     */
    const payload = useMemo(() => ({ content, shortcut, side }), [content, shortcut, side]);
    // A tree outside any TooltipProvider (a detached React root) has no Root to open, so it renders the bare trigger.
    if (!hosts) return children;
    const isCursorMode = anchorMode === 'cursor';
    /**
     * Base UI can open a sibling tooltip in its instant phase before that trigger's first pointer-move handler runs.
     * Capturing pointer-enter as well prevents the open from falling back to the row's bottom edge.
     */
    const capturePointer = isCursorMode
        ? (event: ReactPointerEvent) => {
              rememberPointer(hosts.pointer, event);
          }
        : undefined;
    return (
        <TooltipPrimitive.Trigger
            disabled={disabled}
            handle={isCursorMode ? hosts.cursor : hoverOnly ? hosts.hoverOnly : hosts.element}
            id={triggerId}
            payload={payload}
            render={children}
            onPointerEnter={capturePointer}
            onPointerMove={capturePointer}
        />
    );
}
