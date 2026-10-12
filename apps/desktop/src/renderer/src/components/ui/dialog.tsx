import type { ComponentProps, Ref } from 'react';
import { useRef, useState } from 'react';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';

import { useModalRegistration } from '@/hooks/use-modal-registration';
import { useTranslation } from '@/i18n';
import { restorePickerFocus } from '@/lib/picker-final-focus';
import { cn } from '@/lib/utilities';

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

type DialogPopupProperties = DialogPrimitive.Popup.Props & {
    /**
     * Overrides the close button's accessible name. "Close" describes the mechanism, which is enough wherever closing
     * simply abandons the dialog. A dialog whose closing carries its own meaning (setting a decision aside rather than
     * answering it) has to say that meaning here, because the glyph is identical either way.
     */
    closeLabel?: string;
    ref?: Ref<HTMLDivElement>;
    showCloseButton?: boolean;
};

type DialogContentProperties = DialogPopupProperties & {
    backdropClassName?: string;
};

export function DialogContent({ backdropClassName, ...properties }: DialogContentProperties) {
    return (
        <DialogPortal>
            <DialogOverlay className={backdropClassName} />
            <DialogPopup {...properties} />
        </DialogPortal>
    );
}

/**
 * The popup half of {@link DialogContent}, split out so a variant can run per-open hooks: Base UI's Portal renders
 * nothing while the dialog is closed, so anything rendered inside it mounts fresh on every open even when the owning
 * `Dialog` stays mounted for the app's lifetime (Command Palette, Terminal link picker).
 */
function DialogPopup({
    className,
    children,
    closeLabel,
    showCloseButton = true,
    ...properties
}: DialogPopupProperties) {
    const { t } = useTranslation();
    return (
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
                'fixed top-1/2 left-1/2 z-[51] max-h-[calc(100vh-48px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-surface shadow-[0_16px_48px_var(--shadow)] outline-none',
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
                    className="absolute top-2 right-2 grid size-7 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 hover:bg-elevated"
                    aria-label={closeLabel ?? t('common.close')}
                >
                    <X aria-hidden="true" size={15} />
                </DialogPrimitive.Close>
            )}
        </DialogPrimitive.Popup>
    );
}

/**
 * Shell shared by every picker surface (path browser, command palette, Agent actions, Terminal links). Pickers follow
 * VS Code's quick pick: they float over the workbench near the top without dimming or blurring it, because the user is
 * usually typing while reading Terminal output or the file tree underneath. The backdrop stays mounted but transparent
 * so an outside click still dismisses the picker without reaching the control below it, and the shared modal registry
 * keeps app-wide shortcuts gated while it is open.
 */
export function PickerDialogContent({
    backdropClassName,
    ...properties
}: Omit<DialogContentProperties, 'showCloseButton'>) {
    return (
        <DialogPortal>
            <DialogOverlay className={cn('bg-transparent backdrop-blur-none', backdropClassName)} />
            <PickerPopup {...properties} />
        </DialogPortal>
    );
}

/**
 * Pickers open from keyboard commands, so Base UI has no trigger to hand focus back to on close. `finalFocus` therefore
 * decides from the element that held focus when the picker opened (see `lib/picker-final-focus.ts`). This component
 * lives inside the Portal, which mounts it fresh on every open, so a `useState` initializer captures that element
 * exactly once per open, even for pickers whose `Dialog` stays mounted while closed.
 *
 * The shared restorer owns the focus call and preserves an explicit handoff to another surface.
 */
function PickerPopup({ className, ...properties }: Omit<DialogPopupProperties, 'showCloseButton'>) {
    const popup = useRef<HTMLDivElement>(null);
    const [elementFocusedBeforeOpen] = useState(() =>
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
    return (
        <DialogPopup
            ref={popup}
            className={cn(
                'top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 overflow-hidden',
                className,
            )}
            showCloseButton={false}
            finalFocus={() => {
                restorePickerFocus(elementFocusedBeforeOpen, popup.current);
                return false;
            }}
            {...properties}
        />
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
