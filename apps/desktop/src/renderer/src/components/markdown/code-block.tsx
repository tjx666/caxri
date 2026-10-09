import { useState } from 'react';

import type { MarkdownBlock } from '@caxri/markdown';
import { WrapText } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { CopyIconButton } from './copy-icon-button';
import { useMarkdownContext } from './markdown-context';
import { useColorizedCode } from './use-colorized-code';

type CodeBlockNode = Extract<MarkdownBlock, { type: 'code' }>;

/**
 * A fenced block. Compact hosts show bare text. A transcript gives it a header with the fence language, a soft-wrap
 * toggle for long lines, and a Copy button that stay visible (hover-only controls are undiscoverable on a block the
 * reader is scrolling past), and paints it with the editor's colors once it stops streaming.
 */
export function CodeBlock({ block, isOpen }: { block: CodeBlockNode; isOpen: boolean }) {
    const { variant } = useMarkdownContext();
    const [isWrapped, setWrapped] = useState(false);
    const html = useColorizedCode(block.value, block.language, variant === 'transcript' && !isOpen);
    if (variant === 'compact')
        return (
            <pre className="my-0 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] leading-4 text-foreground">
                {block.value}
            </pre>
        );
    const wrapLabel = isWrapped ? 'Disable word wrap' : 'Enable word wrap';
    return (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
            <div className="flex h-7 items-center gap-1 border-0 border-b border-solid border-border pr-0.5 pl-3 text-[11px] text-muted">
                <span className="min-w-0 flex-1 truncate font-mono">
                    {block.language ?? 'text'}
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
                    copy={() => writeToClipboardWithFeedback(navigator.clipboard, block.value)}
                    label="Copy code"
                />
            </div>
            <pre
                className={cn(
                    'my-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.5] text-foreground',
                    isWrapped && 'wrap-anywhere whitespace-pre-wrap',
                )}
            >
                {html ? (
                    /**
                     * Monaco's colorizer escapes the source and wraps it only in its own color-class spans;
                     * `colorizeCode` rejects any other markup shape before it reaches here.
                     */
                    <code dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                    <code>{block.value}</code>
                )}
            </pre>
        </div>
    );
}
