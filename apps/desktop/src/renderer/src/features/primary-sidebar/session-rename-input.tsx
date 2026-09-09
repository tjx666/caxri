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
            <Input
                ref={focusInput}
                appearance="workbench"
                className="session-rename flex-1 text-foreground"
                aria-label={`Rename ${title}`}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                value={value}
                onBlur={onBlur}
                onChange={(event) => onChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
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
