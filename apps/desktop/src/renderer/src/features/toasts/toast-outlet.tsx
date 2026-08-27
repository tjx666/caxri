import { useState } from 'react';

import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { Button } from '../../components/ui/button';
import { Toast, ToastDismiss, ToastIcon, ToastTitle } from '../../components/ui/toast';
import { motionDurationMs } from '../../lib/motion';
import { dismissToast, useToastStore } from '../../stores/toasts';

/**
 * The notification stack. Errors — and any notice pushed with `persist: true` — have no auto-expiry (`stores/toasts.ts`
 * owns that timing), so every toast carries an explicit dismiss control; clicking the body still dismisses it, which is
 * how the surface behaved before. This motion layer only affects mount/unmount timing, never whether or when a toast
 * disappears.
 */
export function ToastOutlet() {
    const toasts = useToastStore((state) => state.toasts);
    const isReducedMotion = useShouldReduceMotion();
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
    const enterDuration = isReducedMotion ? 0 : durations.enterS;
    const exitDuration = isReducedMotion ? 0 : durations.exitS;
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
                    {toasts.map((toast) => (
                        <m.div
                            key={toast.id}
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
                            <Toast kind={toast.kind} onClick={() => dismissToast(toast.id)}>
                                <ToastIcon kind={toast.kind} />
                                <ToastTitle>{toast.message}</ToastTitle>
                                {toast.action && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            toast.action?.onSelect();
                                            dismissToast(toast.id);
                                        }}
                                    >
                                        {toast.action.label}
                                    </Button>
                                )}
                                <ToastDismiss onClick={() => dismissToast(toast.id)} />
                            </Toast>
                        </m.div>
                    ))}
                </AnimatePresence>
            </LazyMotion>
        </div>
    );
}
