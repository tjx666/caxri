import { useState } from 'react';

import { WrapText } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { CopyIconButton } from './copy-icon-button';
import { useColorizedCode } from './use-colorized-code';

/**
 * A titled block of code: a header with its label, a soft-wrap toggle for long lines, and a Copy button that stay
 * visible (hover-only controls are undiscoverable on a block the reader is scrolling past), over the code painted with
 * the editor's colors. Markdown fences and Agent Chat tool output share it so both read the same.
 */
export function CodeView({
    className,
    code,
    isPaintable = true,
    label,
    language,
}: {
    /**
     * Extra classes for the scrolling `<pre>`, such as a height cap.
     */
    className?: string;
    code: string;
    /**
     * False while the code is still streaming: it is painted once complete.
     */
    isPaintable?: boolean;
    /**
     * Header text. Defaults to the language, or `text` when there is none.
     */
    label?: string;
    /**
     * A fence word, language id, or file extension Monaco can resolve. Unknown or absent stays plain text.
     */
    language: string | undefined;
}) {
    const [isWrapped, setWrapped] = useState(false);
    const html = useColorizedCode(code, language, isPaintable);
    const wrapLabel = isWrapped ? 'Disable word wrap' : 'Enable word wrap';
    return (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
            <div className="flex h-7 items-center gap-1 border-0 border-b border-solid border-border pr-0.5 pl-3 text-[11px] text-muted">
                <span className="min-w-0 flex-1 truncate font-mono">
                    {label ?? language ?? 'text'}
                </span>
                <button
                    aria-label={wrapLabel}
                    aria-pressed={isWrapped}
                    className={cn(
                        'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent',
                        isWrapped && 'text-foreground',
                    )}
                    title={wrapLabel}
                    type="button"
                    onClick={() => setWrapped((value) => !value)}
                >
                    <WrapText className="size-3.5" />
                </button>
                <CopyIconButton
                    copy={() => writeToClipboardWithFeedback(navigator.clipboard, code)}
                    label="Copy code"
                />
            </div>
            <pre
                className={cn(
                    'my-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.5] text-foreground',
                    isWrapped && 'wrap-anywhere whitespace-pre-wrap',
                    className,
                )}
            >
                {html ? (
                    /**
                     * Monaco's colorizer escapes the source and wraps it only in its own color-class spans;
                     * `colorizeCode` rejects any other markup shape before it reaches here.
                     */
                    <code dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                    <code>{code}</code>
                )}
            </pre>
        </div>
    );
}
