import { Input } from '../../components/ui/input';

interface SessionRenameInputProperties {
    sessionId: string;
    title: string;
    error?: string;
    value: string;
    focusInput: (element: HTMLInputElement | null) => void;
    onBlur: () => void;
    onChange: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
}

export function SessionRenameInput({
    sessionId,
    title,
    error,
    value,
    focusInput,
    onBlur,
    onChange,
    onCommit,
    onCancel,
}: SessionRenameInputProperties) {
    const errorId = `session-rename-error-${sessionId}`;
    return (
        <>
            {/*
             * The input replaces the 20px title line inside a `flex-col`, so `flex-1` there would set a zero flex-basis
             * along the column and crush `h-6` to the line height, shrinking the whole row mid-rename. Instead it
             * keeps its 24px box and bleeds 2px into the card's `py-1` on each side, and 5px (padding + border) to the
             * left so the edited text sits exactly where the title was: the row neither shrinks nor grows, and the
             * text does not jump. Size and weight match `.session-title` for the same reason.
             */}
            <Input
                ref={focusInput}
                appearance="workbench"
                className="session-rename -mx-1.25 -my-0.5 w-auto text-[13px] font-medium text-foreground"
                aria-label={`Rename ${title}`}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                value={value}
                onBlur={onBlur}
                onChange={(event) => onChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    /*
                     * While an IME is composing, Enter and Escape belong to the candidate window: Enter accepts the
                     * highlighted candidate, Escape abandons the composition, and the browser dispatches them here
                     * anyway. Committing the rename on that Enter ended the rename on the keystroke the user meant to
                     * finish typing Chinese with, before the accepted text had even reached the input. `isComposing`
                     * is the spec's signal for this; `keyCode === 229` covers the same keystroke on the engines that
                     * report the composition only that way.
                     * https://www.w3.org/TR/uievents/#events-composition-key-events
                     */
                    // oxlint-disable-next-line typescript/no-deprecated -- 229 is the only signal for this keystroke; see comment above
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // eslint-disable-line unicorn/prefer-keyboard-event-key -- `.key` reports "Process" or the composed text here
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onCommit();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancel();
                    }
                }}
                size="compact"
            />
            {error && (
                <span
                    id={errorId}
                    role="alert"
                    className="session-rename-error absolute inset-x-0 top-full z-10 mt-0.5 text-[11px] wrap-break-word text-danger"
                >
                    {error}
                </span>
            )}
        </>
    );
}
