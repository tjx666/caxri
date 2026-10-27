import type { MarkdownBlock } from '@caxri/markdown';
import { tableToHtml, tableToMarkdown } from '@caxri/markdown';

import { useTranslation } from '../../i18n';
import { writeClipboardContent } from '../../lib/clipboard';
import { cn } from '../../lib/utilities';
import { writeRichToClipboardWithFeedback } from '../copy-feedback';
import { BlockFullscreenButton, BlockFullscreenDialog } from './block-fullscreen-dialog';
import { CopyIconButton } from './copy-icon-button';
import { InlineNodes } from './inline-nodes';
import { useMarkdownContext } from './markdown-context';
import { useBlockFullscreen } from './use-block-fullscreen';

type TableBlockNode = Extract<MarkdownBlock, { type: 'table' }>;

const alignClassName = {
    center: 'text-center',
    left: 'text-left',
    right: 'text-right',
} as const;

/**
 * A GFM table. The transcript variant sets it open, as the Codex app does: no frame or header tint, only row hairlines,
 * with the first column flush to the prose. Its Copy and View Full Screen buttons float over the top-right corner only
 * while the pointer is over the table or focus is inside it, on a `--background` pill so they never print over a header
 * cell. Copy puts both Markdown text and an HTML table on the clipboard, so it pastes as a table into a spreadsheet and
 * as Markdown into an editor; full screen lays the table out at the window's width in 13px text.
 */
export function TableBlock({ block }: { block: TableBlockNode }) {
    const { t } = useTranslation();
    const { variant } = useMarkdownContext();
    const fullscreen = useBlockFullscreen();
    if (variant !== 'transcript') return <Table block={block} isTranscript={false} />;
    const copy = (
        <CopyIconButton
            copy={() =>
                writeRichToClipboardWithFeedback(writeClipboardContent, {
                    text: tableToMarkdown(block),
                    html: tableToHtml(block),
                })
            }
            label={t('core.copy.table')}
        />
    );
    return (
        <div className="group/table relative">
            <Table block={block} isTranscript />
            <div className="absolute -top-1 right-0 flex items-center gap-0.5 rounded-md bg-background p-0.5 opacity-0 shadow-[0_0_0_1px_var(--border)] transition-opacity duration-(--motion-feedback) group-focus-within/table:opacity-100 group-hover/table:opacity-100">
                {copy}
                <BlockFullscreenButton onOpen={fullscreen.open} />
            </div>
            <BlockFullscreenDialog
                actions={copy}
                bodyClassName="px-4 py-2"
                isOpen={fullscreen.isOpen}
                title={t('core.block.table')}
                onOpenChange={fullscreen.setOpen}
            >
                <Table block={block} isFullscreen isTranscript />
            </BlockFullscreenDialog>
        </div>
    );
}

function Table({
    block,
    isFullscreen = false,
    isTranscript,
}: {
    block: TableBlockNode;
    isFullscreen?: boolean;
    isTranscript: boolean;
}) {
    const cellClassName = (column: number) =>
        cn(
            'border-0 border-b border-solid border-border align-top',
            isTranscript ? 'px-3 py-2 first:pl-0 last:pr-0' : 'px-2 py-1',
            alignClassName[block.align[column] ?? 'left'],
        );
    return (
        <div className="overflow-x-auto">
            <table
                className={cn(
                    'border-collapse leading-5',
                    isFullscreen ? 'text-[13px]' : 'text-[12px]',
                    isTranscript && 'min-w-full [&_tbody_tr:last-child>td]:border-b-0',
                )}
            >
                <thead>
                    <tr>
                        {block.header.map((cell, column) => (
                            <th
                                className={cn(
                                    cellClassName(column),
                                    'font-semibold text-foreground',
                                    isTranscript && 'whitespace-nowrap',
                                )}
                                key={column}
                                scope="col"
                            >
                                <InlineNodes nodes={cell} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {block.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {row.map((cell, column) => (
                                <td className={cellClassName(column)} key={column}>
                                    <InlineNodes nodes={cell} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
