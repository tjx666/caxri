import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long a transient notice stays on a status line: long enough to read one sentence, short enough that it is gone
 * before the reader has moved on to something else.
 */
const TRANSIENT_NOTICE_MS = 6000;

/**
 * A one-sentence notice that clears itself, for explanations a tap triggers on a control that cannot act (the disabled
 * attach button) or a failure whose row is already gone (a queued message that left the queue). It replaces a system
 * dialog: the sentence shows where the reader is already looking and needs no dismissal. A new notice restarts the
 * timer.
 */
export const useTransientNotice = (
    duration: number = TRANSIENT_NOTICE_MS,
): [string | undefined, (message: string | undefined) => void] => {
    const [notice, setNotice] = useState<string>();
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const show = useCallback(
        (message: string | undefined): void => {
            clearTimeout(timer.current);
            setNotice(message);
            if (message !== undefined)
                timer.current = setTimeout(() => setNotice(undefined), duration);
        },
        [duration],
    );
    useEffect(() => () => clearTimeout(timer.current), []);
    return [notice, show];
};
