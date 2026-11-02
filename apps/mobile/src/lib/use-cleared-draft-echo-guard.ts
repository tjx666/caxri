import { useLayoutEffect, useRef } from 'react';

/**
 * The text the app clears when it empties a draft that held some, or `undefined` for any other change.
 */
export const clearedDraftText = (previous: string, next: string): string | undefined => {
    if (next !== '') return undefined;
    const cleared = previous.trim();
    return cleared === '' ? undefined : cleared;
};

/**
 * Whether a native text change only hands back the text the app just cleared, so the field should stay empty.
 */
export const isClearedDraftEcho = (text: string, cleared: string | undefined): boolean =>
    cleared !== undefined && text.trim() === cleared;

/**
 * Keeps a controlled composer empty after the app clears it. React Native's Android field refuses a value from
 * JavaScript that is older than its own latest native change, so when the keyboard writes into the field (a newline, or
 * a Chinese IME committing its last word) while a Send tap clears it, the clear is dropped and the field reports the
 * sent text back, often in the same JavaScript tick as the tap; the draft then refills with a message that already went
 * out (#3463). The app's own draft writes go through `setDraft`, which records a clear at once; the field's changes go
 * through `onChangeText`, which ignores that echo. The draft stays empty, and React Native's `TextInput` pushes the
 * empty value again with the newer event count, which the field accepts. The first field change that differs from the
 * cleared text ends the guard, so the user's own typing is never dropped; only re-entering the exact sent text as one
 * change right after is.
 *
 * @see https://github.com/react/react-native/blob/v0.88.0/packages/react-native/Libraries/Components/TextInput/TextInput.js
 */
export const useClearedDraftEchoGuard = (
    draft: string,
    onDraftChange: (draft: string) => void,
): { onChangeText: (text: string) => void; setDraft: (draft: string) => void } => {
    const latest = useRef(draft);
    const cleared = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
        latest.current = draft;
    }, [draft]);
    return {
        onChangeText: (text) => {
            if (isClearedDraftEcho(text, cleared.current)) return;
            cleared.current = undefined;
            latest.current = text;
            onDraftChange(text);
        },
        setDraft: (next) => {
            cleared.current = clearedDraftText(latest.current, next);
            latest.current = next;
            onDraftChange(next);
        },
    };
};
