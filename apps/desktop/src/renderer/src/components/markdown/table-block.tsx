import type { MarkdownBlock } from '@caxri/markdown';
import { tableToHtml, tableToMarkdown } from '@caxri/markdown';

import { cn } from '../../lib/utilities';
import { writeRichToClipboardWithFeedback } from '../copy-feedback';
import { CopyIconButton } from './copy-icon-button';
import { InlineNodes } from './inline-nodes';
import { useMarkdownContext } from './markdown-context';

type TableBlockNode = Extract<MarkdownBlock, { type: 'table' }>;

const alignClassName = {
    center: 'text-center',
    left: 'text-left',
    right: 'text-right',
} as const;

/**
 * A GFM table. The transcript variant sets it open, as the Codex app does: no frame or header tint, only row hairlines,
 * with the first column flush to the prose and the last leaving room for its hover Copy button. It adds a Copy button
 * that puts both Markdown text and an HTML table on the clipboard, so it pastes as a table into a spreadsheet and as
 * Markdown into an editor.
 */
export function TableBlock({ block }: { block: TableBlockNode }) {
    const { variant } = useMarkdownContext();
    const isTranscript = variant === 'transcript';
    const cellClassName = (column: number) =>
        cn(
            'border-0 border-b border-solid border-border align-top',
            isTranscript ? 'px-3 py-2 first:pl-0 last:pr-8' : 'px-2 py-1',
            alignClassName[block.align[column] ?? 'left'],
        );
    const table = (
        <div className="overflow-x-auto">
            <table
                className={cn(
                    'border-collapse text-[12px] leading-5',
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
    if (!isTranscript) return table;
    return (
        <div className="group/table relative">
            {table}
            <CopyIconButton
                className="absolute top-0.5 right-0.5 bg-background opacity-0 transition-opacity group-focus-within/table:opacity-100 group-hover/table:opacity-100"
                copy={() =>
                    writeRichToClipboardWithFeedback(navigator.clipboard, {
                        text: tableToMarkdown(block),
                        html: tableToHtml(block),
                    })
                }
                label="Copy table"
            />
        </div>
    );
}
