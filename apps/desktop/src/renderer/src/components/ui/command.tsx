import type { ComponentProps } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { Command as CommandPrimitive, useCommandState } from 'cmdk';

import { cn } from '@/lib/utilities';

export function Command({ className, ...properties }: ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot="command"
            className={cn('flex size-full flex-col overflow-hidden text-foreground', className)}
            {...properties}
        />
    );
}

export function CommandInput({
    className,
    ...properties
}: ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <CommandPrimitive.Input
            data-slot="command-input"
            className={cn(
                // Density and type size match the `palette` tier in `ui/input.tsx`
                // (44px, 13px text); the bottom-hairline chrome instead of a full
                // border box is specific to sitting flush at the top of the palette.
                'h-11 w-full border-0 border-b border-border bg-background px-4 text-[13px] text-foreground transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-muted focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            {...properties}
        />
    );
}

export function CommandList({
    className,
    ...properties
}: Omit<ComponentProps<typeof CommandPrimitive.List>, 'ref'>) {
    const search = useCommandState((state) => state.search);
    const listReference = useRef<HTMLDivElement>(null);
    /**
     * Cmdk only scrolls when selection changes. A refined search with the same first result must also reveal the
     * freshly ranked list instead of retaining the previous scroll position, including with external filtering.
     */
    useLayoutEffect(() => {
        listReference.current?.scrollTo({ top: 0 });
    }, [search]);
    return (
        <CommandPrimitive.List
            ref={listReference}
            data-slot="command-list"
            className={cn('max-h-[360px] overflow-auto p-1', className)}
            {...properties}
        />
    );
}

export function CommandEmpty({
    className,
    ...properties
}: ComponentProps<typeof CommandPrimitive.Empty>) {
    return (
        <CommandPrimitive.Empty
            data-slot="command-empty"
            className={cn('p-6 text-center text-muted', className)}
            {...properties}
        />
    );
}

export function CommandGroup({
    className,
    ...properties
}: ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            data-slot="command-group"
            // Group-heading chrome (`8px` padding, `--muted`, 11px uppercase) is owned
            // by the global `[cmdk-group-heading]` rule in `styles.css`: `cmdk` renders
            // that heading as an internal `<div cmdk-group-heading>` with no prop to
            // reach it via `className`.
            className={cn('overflow-hidden p-1 text-foreground', className)}
            {...properties}
        />
    );
}

export function CommandItem({
    className,
    ...properties
}: ComponentProps<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            data-slot="command-item"
            // `cmdk` toggles its own `data-selected` attribute, so the active-row fill
            // is expressed as a `data-[selected=true]` variant instead of a global-CSS
            // attribute selector. Kept as the unnamed Tailwind `group` so
            // `ShortcutBadge`'s `keyClassName` (e.g. `group-data-[selected=true]:…`)
            // in `command-palette.tsx` keeps working unchanged.
            //
            // `--list-focus-*` rather than a flat surface, so every picker built on this
            // primitive answers an imported theme the way the Files tree does. No hover
            // fill: `cmdk` selects whatever the pointer passes over, so the one row this
            // paints is already the row under the cursor whenever there is one.
            className={cn(
                'group flex min-h-7 cursor-pointer items-start justify-between gap-2 rounded px-2 py-1 outline-none data-[selected=true]:bg-list-focus-background data-[selected=true]:text-list-focus-foreground',
                className,
            )}
            {...properties}
        />
    );
}
