import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';

import { cn } from '@/lib/utils';

export function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
    return <ContextMenuPrimitive.Root {...props} />;
}

export function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
    return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

export function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.Positioner className="z-[70]">
                <ContextMenuPrimitive.Popup
                    data-slot="context-menu-content"
                    className={cn(
                        'min-w-40 rounded-md bg-elevated p-1 text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] outline-none',
                        className,
                    )}
                    {...props}
                />
            </ContextMenuPrimitive.Positioner>
        </ContextMenuPrimitive.Portal>
    );
}

export function ContextMenuItem({ className, ...props }: ContextMenuPrimitive.Item.Props) {
    return (
        <ContextMenuPrimitive.Item
            data-slot="context-menu-item"
            className={cn(
                'flex h-7 cursor-default items-center rounded px-2 text-[12px] outline-none data-highlighted:bg-[var(--selection)] data-disabled:pointer-events-none data-disabled:opacity-45',
                className,
            )}
            {...props}
        />
    );
}

export function ContextMenuSeparator(props: ContextMenuPrimitive.Separator.Props) {
    return (
        <ContextMenuPrimitive.Separator
            data-slot="context-menu-separator"
            className="my-1 h-px bg-border"
            {...props}
        />
    );
}
