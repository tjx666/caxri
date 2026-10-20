import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether `deadline` (epoch milliseconds) has passed, re-rendering once when it does instead of ticking a clock every
 * second. An `undefined` deadline never passes.
 */
export function useIsPast(deadline: number | undefined): boolean {
    const subscribe = useCallback(
        (onChange: () => void) => {
            if (deadline === undefined) return () => {};
            let timer: ReturnType<typeof setTimeout>;
            /**
             * Timers may fire slightly before the wall clock reaches the deadline; re-arm until it does so the snapshot
             * actually flips instead of staying `false` with no further wake-up.
             */
            const arm = () => {
                const remaining = deadline - Date.now();
                timer = remaining > 0 ? setTimeout(arm, remaining) : setTimeout(onChange, 0);
            };
            arm();
            return () => clearTimeout(timer);
        },
        [deadline],
    );
    return useSyncExternalStore(subscribe, () => deadline !== undefined && Date.now() >= deadline);
}
