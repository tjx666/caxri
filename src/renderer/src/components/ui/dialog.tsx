import type { ComponentProps, Ref } from 'react';
import { useEffect, useId } from 'react';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utilities';
import { useDialogStore } from '@/stores/dialogs';

/**
 * Registers this Dialog instance with the shared modal-open registry while `open` is
 * true, and unregisters on close or unmount. Every consumer of the shared `Dialog`
 * primitive gets this for free, so `useDialogStore.isModalOpen()` (which gates
 * app-wide shortcuts in `commands/execute.ts`) stays correct as new dialogs are added
 * without anyone having to remember to OR in another boolean field. A `Set` of
 * `useId()`-derived ids keeps React StrictMode's double-invoked effects idempotent.
 */
function useModalRegistration(open: boolean | undefined): void {
    const id = useId();
    useEffect(() => {
        if (!open) return;
        useDialogStore.getState().registerModal(id);
        return () => useDialogStore.getState().unregisterModal(id);
    }, [open, id]);
}

export function Dialog({ open, ...properties }: DialogPrimitive.Root.Props) {
    useModalRegistration(open);
    return <DialogPrimitive.Root data-slot="dialog" open={open} {...properties} />;
}

function DialogPortal(properties: DialogPrimitive.Portal.Props) {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...properties} />;
}

function DialogOverlay({ className, ...properties }: DialogPrimitive.Backdrop.Props) {
    return (
        <DialogPrimitive.Backdrop
            data-slot="dialog-overlay"
            className={cn(
                'fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]',
                // Backdrop is fade-only: `data-open`/`data-closed` persist for the whole
                // enter/exit run (unlike `data-starting-style`/`data-ending-style`, which
                // are removed after one frame), so gating `animate-in`/`animate-out` on
                // them keeps the keyframe running for the full duration. Base UI keeps the
                // backdrop mounted with `data-closed` set until `Animation.finished`
                // resolves (`useAnimationsFinished`), so the exit keyframe is allowed to
                // complete before unmount.
                'motion-safe:data-open:animate-in data-open:fade-in-0 motion-safe:data-closed:animate-out data-closed:fade-out-0',
                'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                // The keyframes are gated behind `motion-safe:` because a bare
                // `motion-reduce:animate-none` (0,1,0) loses the specificity fight against
                // `data-open:animate-in`'s attribute selector (0,2,0). Under reduced motion
                // no animation runs, so `getAnimations()` reports nothing and Base UI's
                // `useAnimationsFinished` unmounts on close without waiting a frame.
                className,
            )}
            {...properties}
        />
    );
}

export function DialogContent({
    backdropClassName,
    className,
    children,
    showCloseButton = true,
    ...properties
}: DialogPrimitive.Popup.Props & {
    backdropClassName?: string;
    ref?: Ref<HTMLDivElement>;
    showCloseButton?: boolean;
}) {
    return (
        <DialogPortal>
            <DialogOverlay className={backdropClassName} />
            <DialogPrimitive.Popup
                data-slot="dialog-content"
                className={cn(
                    // Tailwind v4 emits centering as the standalone `translate` CSS
                    // property (not `transform`), so it composes independently of the
                    // `enter`/`exit` keyframes below (which animate `transform`) instead
                    // of being clobbered by them.
                    // `outline-none` also covers the popup container itself being focused
                    // (e.g. via `initialFocus`), where the browser would otherwise draw a
                    // default focus ring around the whole dialog.
                    'fixed top-1/2 left-1/2 z-[51] w-[min(520px,calc(100vw-32px))] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-surface shadow-[0_16px_48px_var(--shadow)] outline-none',
                    'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                    'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                    className,
                )}
                {...properties}
            >
                {children}
                {showCloseButton && (
                    <DialogPrimitive.Close
                        data-slot="dialog-close"
                        className="absolute top-2 right-2 grid size-7 place-items-center rounded border-0 bg-transparent p-0 cursor-pointer hover:bg-elevated"
                        aria-label="Close"
                    >
                        <X aria-hidden="true" size={15} />
                    </DialogPrimitive.Close>
                )}
            </DialogPrimitive.Popup>
        </DialogPortal>
    );
}

export function DialogHeader({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="dialog-header"
            className={cn('border-b border-border pt-4 pr-12 pb-3 pl-4', className)}
            {...properties}
        />
    );
}

export function DialogTitle({ className, ...properties }: DialogPrimitive.Title.Props) {
    return (
        <DialogPrimitive.Title
            data-slot="dialog-title"
            className={cn('m-0 text-[15px] font-semibold', className)}
            {...properties}
        />
    );
}

export function DialogDescription({ className, ...properties }: DialogPrimitive.Description.Props) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn('mt-1 mb-0 text-[11px] leading-[1.45] text-muted', className)}
            {...properties}
        />
    );
}
