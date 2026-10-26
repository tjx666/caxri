import { useState } from 'react';

import { CodeXml, Play, WrapText } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { Tooltip } from '../ui/tooltip';
import { BlockFullscreenButton, BlockFullscreenDialog } from './block-fullscreen-dialog';
import { CopyIconButton } from './copy-icon-button';
import { useBlockFullscreen } from './use-block-fullscreen';
import { useColorizedCode } from './use-colorized-code';

/**
 * A titled block of code, lifted onto `--elevated` with its header inside the same panel as the Codex app sets it: the
 * label, then a soft-wrap toggle for long lines, Run when the host can execute the code, Copy, and View Full Screen,
 * over the code painted with the editor's colors. The buttons appear while the pointer is over the block or focus is
 * inside it, so a transcript of code blocks is not lined with icons; they stay reachable by Tab, which reveals them.
 * Full screen shows the same code at the window's width with the same toggles. Markdown fences, Agent Chat tool output,
 * and a background shell's output share it so they read the same, set in the `meta` tier DESIGN.md gives every
 * monospace preview and diff.
 */
export function CodeView({
    className,
    code,
    defaultWrapped = false,
    isPaintable = true,
    label,
    language,
    onRun,
}: {
    /**
     * Extra classes for the scrolling `<pre>`, such as a height cap.
     */
    className?: string;
    code: string;
    /**
     * Starts soft-wrapped, for text that reads as prose; the toggle still switches it.
     */
    defaultWrapped?: boolean;
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
    /**
     * Adds Run before Copy, for code the host can execute. Without it the block only copies.
     */
    onRun?: () => void;
}) {
    const { t } = useTranslation();
    const [isWrapped, setWrapped] = useState(defaultWrapped);
    const fullscreen = useBlockFullscreen();
    const { html, languageName } = useColorizedCode(code, language, isPaintable);
    const title = label ?? languageName ?? language ?? t('core.codeView.plainText');
    const actions = (
        <>
            <WrapToggle isWrapped={isWrapped} onToggle={() => setWrapped((value) => !value)} />
            {onRun && <RunButton onRun={onRun} />}
            <CopyIconButton
                copy={() => writeToClipboardWithFeedback(navigator.clipboard, code)}
                label={t('core.copy.code')}
            />
        </>
    );
    return (
        <div className="group/code overflow-hidden rounded-lg bg-elevated">
            {/* Chrome, not content: a selection running through the block copies the code without its language label. */}
            <div className="flex h-8 items-center gap-1.5 pt-1 pr-1.5 pl-3 text-[12px] text-muted select-none">
                <CodeXml aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-(--motion-feedback) group-focus-within/code:opacity-100 group-hover/code:opacity-100">
                    {actions}
                    <BlockFullscreenButton onOpen={fullscreen.open} />
                </div>
            </div>
            <CodeBody className={className} code={code} html={html} isWrapped={isWrapped} />
            <BlockFullscreenDialog
                actions={actions}
                bodyClassName="bg-elevated"
                isOpen={fullscreen.isOpen}
                title={title}
                onOpenChange={fullscreen.setOpen}
            >
                <CodeBody
                    className="min-h-full px-4 pt-3 pb-4 text-[12px]"
                    code={code}
                    html={html}
                    isWrapped={isWrapped}
                />
            </BlockFullscreenDialog>
        </div>
    );
}

function RunButton({ onRun }: { onRun: () => void }) {
    const { t } = useTranslation();
    const label = t('core.codeView.runInTerminal');
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={onRun}
            >
                <Play className="size-3.5" />
            </button>
        </Tooltip>
    );
}

function WrapToggle({ isWrapped, onToggle }: { isWrapped: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const wrapLabel = t(
        isWrapped ? 'core.codeView.disableWordWrap' : 'core.codeView.enableWordWrap',
    );
    return (
        <Tooltip content={wrapLabel}>
            <button
                aria-label={wrapLabel}
                aria-pressed={isWrapped}
                className={cn(
                    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent',
                    isWrapped && 'text-foreground',
                )}
                type="button"
                onClick={onToggle}
            >
                <WrapText className="size-3.5" />
            </button>
        </Tooltip>
    );
}

function CodeBody({
    className,
    code,
    html,
    isWrapped,
}: {
    className?: string;
    code: string;
    html: string | undefined;
    isWrapped: boolean;
}) {
    return (
        <pre
            className={cn(
                'my-0 overflow-x-auto px-3 pt-1 pb-2.5 font-mono text-[11px] leading-[1.5] text-foreground',
                isWrapped && 'wrap-anywhere whitespace-pre-wrap',
                className,
            )}
        >
            {html ? (
                /**
                 * Monaco's colorizer escapes the source and wraps it only in its own color-class spans; `colorizeCode`
                 * rejects any other markup shape before it reaches here.
                 */
                <code dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
                <code>{code}</code>
            )}
        </pre>
    );
}
