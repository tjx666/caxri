import type { ComponentProps } from 'react';

import { CircleCheck, CircleX, Info, X } from 'lucide-react';

import { cn } from '@/lib/utilities';

export type ToastKind = 'info' | 'success' | 'error';

const TOAST_ICONS: Record<ToastKind, typeof Info> = {
    error: CircleX,
    info: Info,
    success: CircleCheck,
};

/**
 * Presentational notification card only — `features/toasts` owns the store, stacking, timing, and Motion enter/exit
 * (DESIGN.md Motion layer 4); this primitive has no queue or manager state of its own, unlike the shadcn/Base UI
 * `Toast` template it replaces.
 */
export function Toast({
    className,
    kind,
    ...properties
}: ComponentProps<'div'> & { kind: ToastKind }) {
    return (
        <div
            data-slot="toast"
            data-kind={kind}
            className={cn(
                'toast flex max-w-[460px] items-start gap-2 rounded-md border border-l-[3px] border-border border-l-muted bg-elevated px-3 py-2 text-left shadow-[0_8px_24px_var(--shadow)]',
                kind === 'success' && 'border-l-success',
                kind === 'error' && 'border-l-danger',
                className,
            )}
            {...properties}
        />
    );
}

/**
 * Status-matching icon. `info` stays `text-muted` — DESIGN.md reserves `--accent` for the single focus indicator, so
 * the left bar and icon never borrow it for a third status color.
 */
export function ToastIcon({
    className,
    kind,
    ...properties
}: Omit<ComponentProps<typeof Info>, 'children'> & { kind: ToastKind }) {
    const Icon = TOAST_ICONS[kind];
    return (
        <Icon
            data-slot="toast-icon"
            className={cn(
                'mt-px flex-none text-muted',
                kind === 'success' && 'text-success',
                kind === 'error' && 'text-danger',
                className,
            )}
            size={14}
            aria-hidden="true"
            {...properties}
        />
    );
}

export function ToastTitle({ className, ...properties }: ComponentProps<'span'>) {
    return (
        <span
            data-slot="toast-title"
            className={cn(
                'min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere] text-foreground',
                className,
            )}
            {...properties}
        />
    );
}

export function ToastDismiss({ className, ...properties }: ComponentProps<'button'>) {
    return (
        <button
            type="button"
            data-slot="toast-dismiss"
            aria-label="Dismiss notification"
            className={cn(
                'grid size-4 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] hover:text-foreground',
                className,
            )}
            {...properties}
        >
            <X size={12} aria-hidden="true" />
        </button>
    );
}
