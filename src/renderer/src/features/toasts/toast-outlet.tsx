import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react';
import * as m from 'motion/react-m';
import { useState } from 'react';

import { motionDurationMs, usePrefersReducedMotion } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { dismissToast, useToastStore, type ToastKind } from '../../stores/toasts';

const TOAST_ICONS: Record<ToastKind, typeof Info> = {
    error: CircleX,
    info: Info,
    success: CircleCheck,
};

/**
 * The notification stack. Errors — and any notice pushed with `persist: true` — have no
 * auto-expiry (`stores/toasts.ts` owns that timing), so every toast carries an explicit dismiss
 * control; clicking the body still dismisses it, which is how the surface behaved before. This
 * motion layer only affects mount/unmount timing, never whether or when a toast disappears.
 */
export function ToastOutlet() {
    const toasts = useToastStore((state) => state.toasts);
    const reducedMotion = usePrefersReducedMotion();
    // Token values need a live DOM (`getComputedStyle`), so a lazy `useState` initializer reads
    // them once instead of at module scope. Toasts are the closest DESIGN.md motion layer has to
    // an "overlay" notification (dialogs, popovers) rather than persistent chrome, so their
    // enter/exit borrows the `--motion-overlay-*` tokens through `lib/motion.ts` instead of an
    // independent literal duration. This still needs Motion's `AnimatePresence` (DESIGN.md layer
    // 4) rather than the shadcn/tw-animate-css layer: that layer's animation classes are gated on
    // Base UI's `data-open`/`data-closed` popup state, which this bespoke stacked list never
    // produces — the same reasoning the work tab strip already applies to its own enter/exit.
    const [durations] = useState(() => ({
        enterS: motionDurationMs('--motion-overlay-enter') / 1000,
        exitS: motionDurationMs('--motion-overlay-exit') / 1000,
    }));
    const enterDuration = reducedMotion ? 0 : durations.enterS;
    const exitDuration = reducedMotion ? 0 : durations.exitS;
    return (
        <div
            className="fixed right-4 bottom-10 z-[80] flex flex-col items-end gap-2"
            role="status"
            aria-live="polite"
        >
            {/* The wrapper always renders (unlike the previous `toasts.length === 0` early
                return) so `AnimatePresence` stays mounted long enough to play the last toast's
                exit animation instead of having its whole tree torn down mid-transition. */}
            <LazyMotion strict features={domAnimation}>
                <AnimatePresence initial={false}>
                    {toasts.map((toast) => {
                        const Icon = TOAST_ICONS[toast.kind];
                        return (
                            <m.div
                                key={toast.id}
                                className={cn(
                                    'toast',
                                    'flex max-w-[460px] items-start gap-2 rounded-md border border-border border-l-[3px] border-l-muted bg-elevated px-3 py-2 text-left shadow-[0_8px_24px_var(--shadow)]',
                                    toast.kind === 'success' && 'border-l-success',
                                    toast.kind === 'error' && 'border-l-danger',
                                )}
                                onClick={() => dismissToast(toast.id)}
                                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                                animate={{
                                    opacity: 1,
                                    y: 0,
                                    scale: 1,
                                    transition: { duration: enterDuration, ease: 'easeOut' },
                                }}
                                exit={{
                                    opacity: 0,
                                    scale: 0.97,
                                    transition: { duration: exitDuration, ease: 'easeIn' },
                                }}
                            >
                                <Icon
                                    className={cn(
                                        'mt-px flex-none text-muted',
                                        toast.kind === 'success' && 'text-success',
                                        toast.kind === 'error' && 'text-danger',
                                    )}
                                    size={14}
                                    aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                                    {toast.message}
                                </span>
                                <button
                                    type="button"
                                    className="grid size-4 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-[var(--selection)] hover:text-foreground"
                                    aria-label="Dismiss notification"
                                    onClick={() => dismissToast(toast.id)}
                                >
                                    <X size={12} aria-hidden="true" />
                                </button>
                            </m.div>
                        );
                    })}
                </AnimatePresence>
            </LazyMotion>
        </div>
    );
}
