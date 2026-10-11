import { useState } from 'react';

import { CodeXml, WrapText } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { Tooltip } from '../ui/tooltip';
import { CopyIconButton } from './copy-icon-button';
import { useColorizedCode } from './use-colorized-code';

/**
 * A titled block of code, lifted onto `--elevated` with its header inside the same panel as the Codex app sets it: the
 * label, a soft-wrap toggle for long lines, and a Copy button that stay visible (hover-only controls are undiscoverable
 * on a block the reader is scrolling past), over the code painted with the editor's colors. Markdown fences, Agent Chat
 * tool output, and a background shell's output share it so they read the same, set in the `meta` tier DESIGN.md gives
 * every monospace preview and diff.
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
    const { html, languageName } = useColorizedCode(code, language, isPaintable);
    const wrapLabel = isWrapped ? 'Disable word wrap' : 'Enable word wrap';
    return (
        <div className="overflow-hidden rounded-lg bg-elevated">
            {/* Chrome, not content: a selection running through the block copies the code without its language label. */}
            <div className="flex h-8 items-center gap-1.5 pt-1 pr-1.5 pl-3 text-[12px] text-muted select-none">
                <CodeXml aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                    {label ?? languageName ?? language ?? 'Text'}
                </span>
                <Tooltip content={wrapLabel}>
                    <button
                        aria-label={wrapLabel}
                        aria-pressed={isWrapped}
                        className={cn(
                            'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent',
                            isWrapped && 'text-foreground',
                        )}
                        type="button"
                        onClick={() => setWrapped((value) => !value)}
                    >
                        <WrapText className="size-3.5" />
                    </button>
                </Tooltip>
                <CopyIconButton
                    copy={() => writeToClipboardWithFeedback(navigator.clipboard, code)}
                    label="Copy code"
                />
            </div>
            <pre
                className={cn(
                    'my-0 overflow-x-auto px-3 pt-1 pb-2.5 font-mono text-[11px] leading-[1.5] text-foreground',
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
