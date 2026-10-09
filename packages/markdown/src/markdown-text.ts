import type { MarkdownBlock, MarkdownInline } from './markdown-blocks.js';

type MarkdownTable = Extract<MarkdownBlock, { type: 'table' }>;

/**
 * The visible text of inline content, with formatting dropped and hard breaks kept as spaces.
 */
export function inlinePlainText(nodes: readonly MarkdownInline[]): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case 'text':
                case 'code': {
                    return node.value;
                }
                case 'break': {
                    return ' ';
                }
                default: {
                    return inlinePlainText(node.children);
                }
            }
        })
        .join('');
}

const DELIMITER = { center: ':---:', left: ':---', right: '---:' } as const;

function markdownCell(nodes: readonly MarkdownInline[]): string {
    return inlinePlainText(nodes).replaceAll('|', String.raw`\|`);
}

/**
 * Re-serializes a table as GitHub-flavored Markdown, so a copied table pastes back into a Chat, an issue, or a document
 * as a table. Cell formatting is reduced to its text.
 */
export function tableToMarkdown(table: MarkdownTable): string {
    const row = (cells: readonly MarkdownInline[][]) =>
        `| ${cells.map((cell) => markdownCell(cell)).join(' | ')} |`;
    const delimiter = `| ${table.header
        .map((_, column) => {
            const align = table.align[column];
            return align ? DELIMITER[align] : '---';
        })
        .join(' | ')} |`;
    return [row(table.header), delimiter, ...table.rows.map((cells) => row(cells))].join('\n');
}

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * The table as a bare HTML `<table>`, the clipboard flavor spreadsheets and rich-text editors paste as real cells.
 * Every cell is escaped plain text.
 */
export function tableToHtml(table: MarkdownTable): string {
    const cells = (tag: 'td' | 'th', row: readonly MarkdownInline[][]) =>
        row.map((cell) => `<${tag}>${escapeHtml(inlinePlainText(cell))}</${tag}>`).join('');
    const body = table.rows.map((row) => `<tr>${cells('td', row)}</tr>`).join('');
    return `<table><thead><tr>${cells('th', table.header)}</tr></thead><tbody>${body}</tbody></table>`;
}
