import { useLayoutEffect, useRef } from 'react';

/**
 * The text a draft change cleared from the field, when the app emptied it rather than the user: the draft went from
 * text to empty while the native field still held text (a user who deleted everything reported the empty field first).
 * `undefined` for any other change.
 */
export const clearedDraftText = (
    previous: string,
    next: string,
    nativeText: string,
): string | undefined => {
    if (next !== '' || nativeText === '') return undefined;
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
 * sent text back; the draft then refills with a message that already went out (#3463). The returned `onChangeText`
 * ignores that echo: the draft stays empty, and React Native's `TextInput` pushes the empty value again with the newer
 * event count, which the field accepts. The first change that differs from the cleared text ends the guard, so the
 * user's own typing is never dropped; only re-entering the exact sent text as one change right after is.
 *
 * @see https://github.com/facebook/react-native/blob/v0.88.0/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt
 */
export const useClearedDraftEchoGuard = (
    draft: string,
    onDraftChange: (draft: string) => void,
): ((text: string) => void) => {
    const previousDraft = useRef(draft);
    const nativeText = useRef(draft);
    const cleared = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
        const text = clearedDraftText(previousDraft.current, draft, nativeText.current);
        console.log('[3463] effect', JSON.stringify({ previous: previousDraft.current, draft, native: nativeText.current, text }));
        if (text !== undefined) cleared.current = text;
        previousDraft.current = draft;
        // The field shows the draft from here on, whether the user typed it or the app set it.
        nativeText.current = draft;
    }, [draft]);
    return (text: string): void => {
        console.log('[3463] change', JSON.stringify({ text, cleared: cleared.current }));
        if (isClearedDraftEcho(text, cleared.current)) return;
        cleared.current = undefined;
        nativeText.current = text;
        onDraftChange(text);
    };
};
