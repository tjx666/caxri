import { LoaderCircle, Sparkles } from 'lucide-react';

import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';
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
    const { t } = useTranslation();
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
                aria-label={t('primarySidebar.rename.inputAriaLabel', { title })}
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
                     * Enter while an IME is composing accepts the candidate; committing the rename on it ended the
                     * rename before the accepted text reached the input. See `isImeComposing`.
                     */
                    if (isImeComposing(event)) return;
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
                <Tooltip
                    content={t('primarySidebar.sessionMenu.renameWithAi')}
                    shortcut="shift+enter"
                >
                    <button
                        type="button"
                        className={`${sessionRowActionButton} session-rename-suggest flex-none disabled:cursor-default`}
                        aria-label={t('primarySidebar.rename.suggestAriaLabel', { title })}
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
