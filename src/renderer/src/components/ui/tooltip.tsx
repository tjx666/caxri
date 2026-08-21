import type { ReactElement, ReactNode } from 'react';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { CommandId } from '@shared/commands';
import { getCommandDefinition } from '@shared/commands';

import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import { ShortcutBadge } from '../shortcut-badge';

export function TooltipProvider({ children }: { children: ReactNode }) {
    return (
        <TooltipPrimitive.Provider delay={500} closeDelay={80} timeout={300}>
            {children}
        </TooltipPrimitive.Provider>
    );
}

export function Tooltip({
    children,
    content,
    shortcut,
    triggerId,
}: {
    children: ReactElement;
    content: ReactNode;
    shortcut?: string;
    /**
     * Required when the trigger element needs an `id` of its own (a WAI-ARIA `role="tab"`, for example).
     *
     * Base UI writes its generated trigger id onto the rendered element, but merges the element's own props last, so a
     * plain `id` on the child silently wins — and the tooltip store is then keyed to an id no element carries, leaving
     * the tooltip permanently closed. Passing the id here makes the store and the DOM agree; the child must not also
     * set one.
     */
    triggerId?: string;
}) {
    return (
        <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger id={triggerId} render={children} />
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Positioner className="z-[90]" side="bottom" sideOffset={6}>
                    <TooltipPrimitive.Popup
                        className={cn(
                            // Kept as a plain class (not `data-slot`) because
                            // `e2e/sidebar-chrome.e2e.ts` locates it via `.tooltip-popup`.
                            'tooltip-popup flex max-w-80 items-center gap-3 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                            // `TooltipPositioner` exposes `--transform-origin`
                            // (`TooltipPositionerCssVars`) and it inherits down to this
                            // popup, so the zoom animation scales from the trigger edge.
                            'origin-(--transform-origin)',
                            // Switched from the previous transition-less
                            // `data-[starting-style]/[ending-style]:opacity-0` (which never
                            // actually animated) to the same keyframe-based `animate-in`/
                            // `animate-out` pattern as the other overlay popups. Gating on
                            // `data-open`/`data-closed` (which persist for the whole
                            // enter/exit run, unlike the one-frame starting/ending-style
                            // attributes) keeps the keyframe running to completion; Base UI
                            // keeps the tooltip mounted until `getAnimations()` reports
                            // nothing running.
                            'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                            'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                            // The keyframes are gated behind `motion-safe:` because a bare
                            // `motion-reduce:animate-none` (0,1,0) loses the specificity
                            // fight against `data-open:animate-in`'s attribute selector
                            // (0,2,0). Under reduced motion no animation runs, so
                            // `getAnimations()` reports nothing and close unmounts without
                            // waiting a frame.
                        )}
                    >
                        <span>{content}</span>
                        {shortcut && (
                            <ShortcutBadge className="ml-auto" compact shortcut={shortcut} />
                        )}
                    </TooltipPrimitive.Popup>
                </TooltipPrimitive.Positioner>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
}

export function CommandTooltip({
    children,
    commandId,
}: {
    children: ReactElement;
    commandId: CommandId;
}) {
    const shortcut = useCommandShortcut(commandId);
    const command = getCommandDefinition(commandId);
    return (
        <Tooltip content={command.description} shortcut={shortcut}>
            {children}
        </Tooltip>
    );
}
