import { LoaderCircle, Sparkles } from 'lucide-react';

import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { sessionRowActionButton } from './session-row-actions';

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
    /**
     * Asks for a name generated from the Session's Agent conversation; `Shift+Enter` in the input does the same.
     */
    onSuggest: () => void;
    /**
     * Whether the Session has a primary Agent conversation to name. A Shell-only Session hides the AI button and
     * ignores `Shift+Enter` rather than offering an action that can only fail.
     */
    canSuggest: boolean;
    /**
     * A suggestion is in flight: the input turns read-only so the answer cannot overwrite something typed meanwhile.
     */
    suggesting: boolean;
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
    onSuggest,
    canSuggest,
    suggesting,
}: SessionRenameInputProperties) {
    const errorId = `session-rename-error-${sessionId}`;
    return (
        <>
            {/*
             * The input fills the row up to the AI button, so the row never overflows: an overflowing row shrank the
             * Agent icon beside it and shifted the edited text. It keeps its 24px box and bleeds 2px into the card's
             * `py-1` on each side, and 5px (padding + border) to the left so the edited text sits exactly where the
             * title was: the row neither shrinks nor grows, and the text does not jump. Size and weight match
             * `.session-title` for the same reason.
             */}
            <Input
                ref={focusInput}
                appearance="workbench"
                className="session-rename -mx-1.25 -my-0.5 w-auto flex-1 text-[13px] font-medium text-foreground"
                aria-label={`Rename ${title}`}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                value={value}
                readOnly={suggesting}
                aria-busy={suggesting}
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
                    if (event.key === 'Enter' && event.shiftKey) {
                        event.preventDefault();
                        if (canSuggest) onSuggest();
                    } else if (event.key === 'Enter') {
                        event.preventDefault();
                        onCommit();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancel();
                    }
                }}
                size="compact"
            />
            {canSuggest && (
                <Tooltip content="Rename with AI" shortcut="shift+enter">
                    <button
                        type="button"
                        className={`${sessionRowActionButton} session-rename-suggest flex-none disabled:cursor-default`}
                        aria-label={`Rename ${title} with AI`}
                        aria-keyshortcuts="Shift+Enter"
                        disabled={suggesting}
                        tabIndex={-1}
                        // Keeps focus in the input: a blur would end the rename before the click lands.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onSuggest();
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                    >
                        {suggesting ? (
                            <LoaderCircle size={12} className="motion-safe:animate-spin" />
                        ) : (
                            <Sparkles size={12} />
                        )}
                    </button>
                </Tooltip>
            )}
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
