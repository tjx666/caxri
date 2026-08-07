import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

import { getCommandDefinition } from '@shared/commands';

import { useCommandShortcut } from '../../lib/keybindings';

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
}: {
    children: ReactElement;
    content: ReactNode;
    shortcut?: string;
}) {
    return (
        <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger render={children} />
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Positioner className="z-[90]" side="bottom" sideOffset={6}>
                    <TooltipPrimitive.Popup className="tooltip-popup flex max-w-80 items-center gap-3 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
                        <span>{content}</span>
                        {shortcut && (
                            <kbd className="ml-auto shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 font-sans text-[11px] leading-none text-muted">
                                {shortcut}
                            </kbd>
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
    commandId: string;
}) {
    const shortcut = useCommandShortcut(commandId);
    const command = getCommandDefinition(commandId);
    return (
        <Tooltip content={command.description} shortcut={shortcut}>
            {children}
        </Tooltip>
    );
}
