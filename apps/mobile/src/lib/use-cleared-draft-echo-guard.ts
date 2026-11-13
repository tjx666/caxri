import { useLayoutEffect, useRef } from 'react';

/**
 * How long after a clear the field may still hand back the cleared text as an echo. The keyboard's late write lands in
 * the same JavaScript tick as the Send tap or a few frames after it; anything later is the user typing. Without this
 * bound, re-entering a one-letter message such as `a` (answering an Agent's option list) was dropped on every press, so
 * the letter flashed into the field and vanished (#3817).
 */
export const CLEARED_DRAFT_ECHO_WINDOW_MS = 500;

/**
 * A clear the guard still watches for: the cleared text and when the app cleared it.
 */
export interface ClearedDraft {
    /**
     * Milliseconds since the epoch at the clear.
     */
    at: number;
    text: string;
}

/**
 * The clear the app makes when it empties a draft that held some, or `undefined` for any other change.
 */
export const clearedDraft = (
    previous: string,
    next: string,
    now: number,
): ClearedDraft | undefined => {
    if (next !== '') return undefined;
    const text = previous.trim();
    return text === '' ? undefined : { at: now, text };
};

/**
 * Whether a native text change only hands back the text the app just cleared, so the field should stay empty. The echo
 * may also be the sent text short of its end: an IME still composing the last word (`keys` typed through a Chinese
 * keyboard's English mode) hands back what the field held before that word's last keystroke, so the draft refilled with
 * the message minus its final letter. A prefix counts only while it keeps at least half the sent text, so a different
 * short message typed right after a send is never taken for one.
 */
export const isClearedDraftEcho = (
    text: string,
    cleared: ClearedDraft | undefined,
    now: number,
): boolean => {
    if (cleared === undefined || now - cleared.at > CLEARED_DRAFT_ECHO_WINDOW_MS) return false;
    const echo = text.trim();
    return (
        echo === cleared.text ||
        (echo !== '' && echo.length * 2 >= cleared.text.length && cleared.text.startsWith(echo))
    );
};

/**
 * Keeps a controlled composer empty after the app clears it. React Native's Android field refuses a value from
 * JavaScript that is older than its own latest native change, so when the keyboard writes into the field (a newline, or
 * a Chinese IME committing its last word) while a Send tap clears it, the clear is dropped and the field reports the
 * sent text back, often in the same JavaScript tick as the tap; the draft then refills with a message that already went
 * out (#3463). The app's own draft writes go through `setDraft`, which records a clear at once; the field's changes go
 * through `onChangeText`, which ignores that echo. The draft stays empty, and React Native's `TextInput` pushes the
 * empty value again with the newer event count, which the field accepts. The guard ends at the first field change that
 * differs from the cleared text or once `CLEARED_DRAFT_ECHO_WINDOW_MS` has passed, so the user's own typing is never
 * dropped; only the sent text (or most of it, see `isClearedDraftEcho`) arriving as one change right after the clear
 * is.
 *
 * @see https://github.com/react/react-native/blob/v0.88.0/packages/react-native/Libraries/Components/TextInput/TextInput.js
 */
export const useClearedDraftEchoGuard = (
    draft: string,
    onDraftChange: (draft: string) => void,
): { onChangeText: (text: string) => void; setDraft: (draft: string) => void } => {
    const latest = useRef(draft);
    const cleared = useRef<ClearedDraft | undefined>(undefined);
    useLayoutEffect(() => {
        latest.current = draft;
    }, [draft]);
    return {
        onChangeText: (text) => {
            if (isClearedDraftEcho(text, cleared.current, Date.now())) return;
            cleared.current = undefined;
            latest.current = text;
            onDraftChange(text);
        },
        setDraft: (next) => {
            cleared.current = clearedDraft(latest.current, next, Date.now());
            latest.current = next;
            onDraftChange(next);
        },
    };
};
