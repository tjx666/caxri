import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';

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

export function TooltipProvider({ children }: { children: ReactNode }) {
    return (
        <TooltipPrimitive.Provider delay={500} closeDelay={80} timeout={300}>
            {children}
        </TooltipPrimitive.Provider>
    );
}

export function Tooltip({
    anchorMode = 'element',
    children,
    content,
    disabled,
    hoverOnly,
    shortcut,
    side: elementSide = 'bottom',
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
    side?: 'bottom' | 'left' | 'right' | 'top';
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
    const latestPointer = useRef<{ x: number; y: number }>(undefined);
    const [cursorAnchor, setCursorAnchor] = useState<TooltipCursorAnchor>();
    /**
     * Installs cursor collision middleware before the first popup mount. The hover-open callback establishes the anchor
     * asynchronously; waiting for that state lets a first right-edge open use Base UI's default flip behavior and
     * overflow by the cursor offset.
     */
    const isCursorMode = anchorMode === 'cursor';
    const isCursorAnchored = anchorMode === 'cursor' && cursorAnchor !== undefined;
    /**
     * Base UI can open a sibling tooltip in its instant phase before that trigger's first pointer-move handler runs.
     * Capturing pointer-enter as well prevents the open from falling back to the row's bottom edge.
     */
    const capturePointer = isCursorMode
        ? (event: ReactPointerEvent) => {
              latestPointer.current = { x: event.clientX, y: event.clientY };
          }
        : undefined;
    /**
     * Keeps the popup beside the pointer so its vertical path through adjacent tree rows stays clear. Floating UI flips
     * the popup to the left near the right edge without moving it across that path.
     */
    const side = isCursorAnchored ? 'right' : elementSide;
    return (
        <TooltipPrimitive.Root
            disabled={disabled}
            onOpenChange={
                hoverOnly || isCursorMode
                    ? (open, details) => {
                          /**
                           * Base UI calls this before it commits the open, and honors `cancel()` by dropping the change
                           * entirely, so the popup never mounts rather than mounting and being closed again.
                           */
                          if (hoverOnly && open && details.reason === 'trigger-focus') {
                              details.cancel();
                              return;
                          }
                          if (isCursorMode && open) {
                              setCursorAnchor(
                                  resolveTooltipCursorAnchor(
                                      open,
                                      details.reason,
                                      latestPointer.current,
                                  ),
                              );
                          }
                      }
                    : undefined
            }
            onOpenChangeComplete={
                anchorMode === 'cursor'
                    ? (open) => {
                          if (!open) setCursorAnchor(undefined);
                      }
                    : undefined
            }
        >
            <TooltipPrimitive.Trigger
                id={triggerId}
                render={children}
                onPointerEnter={capturePointer}
                onPointerMove={capturePointer}
            />
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Positioner
                    align={isCursorAnchored ? 'start' : undefined}
                    anchor={isCursorAnchored ? cursorAnchor : undefined}
                    className="z-[90] max-w-[var(--available-width)]"
                    collisionAvoidance={
                        isCursorMode
                            ? { side: 'flip', align: 'shift', fallbackAxisSide: 'none' }
                            : undefined
                    }
                    collisionPadding={isCursorMode ? TOOLTIP_CURSOR_COLLISION_PADDING : undefined}
                    positionMethod={isCursorAnchored ? 'fixed' : undefined}
                    side={side}
                    sideOffset={isCursorAnchored ? TOOLTIP_CURSOR_SIDE_OFFSET : 6}
                >
                    <TooltipPrimitive.Popup
                        className={cn(
                            // Kept as a plain class (not `data-slot`) because E2E reads a tooltip's rendered text
                            // through `.tooltip-popup` (`e2e/statusbar.e2e.ts`, `e2e/editor-git-actions.e2e.ts`).
                            'tooltip-popup flex max-w-80 items-center gap-3 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                            TOOLTIP_MOTION,
                        )}
                    >
                        <span className="min-w-0 wrap-anywhere whitespace-pre-line">{content}</span>
                        {shortcut && (
                            <ShortcutBadge className="ml-auto" compact shortcut={shortcut} />
                        )}
                    </TooltipPrimitive.Popup>
                </TooltipPrimitive.Positioner>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
}
