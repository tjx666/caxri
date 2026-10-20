import { useEffect, useRef, useState } from 'react';

/**
 * How long a refused Enter's reason stays in the composer strip: long enough to read a short sentence, short enough
 * that it never reads as the Chat's state.
 */
const NOTICE_MS = 2000;

/**
 * How long a notice that teaches a shortcut stays, since its sentence is longer than a refusal's reason.
 */
export const LONG_NOTICE_MS = 4000;

/**
 * A short-lived line for the composer strip, such as why Enter did not send. `show` replaces any line still on screen
 * and restarts its timer; the line clears itself after {@link NOTICE_MS}, or after `durationMs` when given.
 */
export function useAgentChatComposerNotice() {
    const [notice, setNotice] = useState<string>();
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const show = (text: string, durationMs: number = NOTICE_MS): void => {
        clearTimeout(timer.current);
        setNotice(text);
        timer.current = setTimeout(() => setNotice(undefined), durationMs);
    };
    return { notice, show };
}
