import type { ReactNode } from 'react';

import type { MarkdownBlock } from '@caxri/markdown';
import { blocksPlainText } from '@caxri/markdown';

import { useTranslation } from '../../i18n';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { CopyIconButton } from './copy-icon-button';
import { useMarkdownContext } from './markdown-context';

type QuoteBlockNode = Extract<MarkdownBlock, { type: 'quote' }>;

const QUOTE_CLASS_NAME =
    'my-0 flex flex-col gap-2 border-0 border-l-2 border-solid border-border pl-3 text-muted';

/**
 * A block quote, rendered from `children` (the quote's own blocks). In a transcript it adds a hover Copy button, as a
 * table does, because an Agent often quotes the text it suggests sending on: a draft reply or message. The copy is the
 * quote's words without its `>` markers (`blocksPlainText`), so it pastes as the message itself. The quote leaves room
 * on the right for the button so it never covers the last word of a line.
 */
export function QuoteBlock({ block, children }: { block: QuoteBlockNode; children: ReactNode }) {
    const { t } = useTranslation();
    const { variant } = useMarkdownContext();
    if (variant !== 'transcript')
        return <blockquote className={QUOTE_CLASS_NAME}>{children}</blockquote>;
    return (
        <div className="group/quote relative">
            <blockquote className={`${QUOTE_CLASS_NAME} pr-8`}>{children}</blockquote>
            <CopyIconButton
                className="absolute top-0 right-0 bg-background opacity-0 transition-opacity group-focus-within/quote:opacity-100 group-hover/quote:opacity-100"
                copy={() =>
                    writeToClipboardWithFeedback(
                        navigator.clipboard,
                        blocksPlainText(block.children),
                    )
                }
                label={t('core.copy.quote')}
            />
        </div>
    );
}
