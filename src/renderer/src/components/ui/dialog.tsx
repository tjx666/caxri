import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useEffect, useId } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';
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

export function Dialog({ open, ...props }: DialogPrimitive.Root.Props) {
    useModalRegistration(open);
    return <DialogPrimitive.Root data-slot="dialog" open={open} {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
    return (
        <DialogPrimitive.Backdrop
            data-slot="dialog-overlay"
            className={cn('fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]', className)}
            {...props}
        />
    );
}

export function DialogContent({
    className,
    children,
    showCloseButton = true,
    ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
    return (
        <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Popup
                data-slot="dialog-content"
                className={cn(
                    'fixed top-1/2 left-1/2 z-[51] w-[min(520px,calc(100vw-32px))] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-surface shadow-[0_16px_48px_var(--shadow)]',
                    className,
                )}
                {...props}
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

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="dialog-header"
            className={cn('border-b border-border pt-4 pr-12 pb-3 pl-4', className)}
            {...props}
        />
    );
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
    return (
        <DialogPrimitive.Title
            data-slot="dialog-title"
            className={cn('m-0 text-[15px] font-semibold', className)}
            {...props}
        />
    );
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn('mt-1 mb-0 text-[11px] leading-[1.45] text-muted', className)}
            {...props}
        />
    );
}
