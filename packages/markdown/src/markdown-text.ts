import type { MarkdownBlock, MarkdownInline, MarkdownListItem } from './markdown-blocks.js';

type MarkdownTable = Extract<MarkdownBlock, { type: 'table' }>;

/**
 * The visible text of inline content, with formatting dropped and hard breaks kept as `breakText`: a space by default,
 * for a single-line target such as a table cell.
 */
export function inlinePlainText(nodes: readonly MarkdownInline[], breakText = ' '): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case 'text':
                case 'code': {
                    return node.value;
                }
                case 'break': {
                    return breakText;
                }
                default: {
                    return inlinePlainText(node.children, breakText);
                }
            }
        })
        .join('');
}

function indentFollowingLines(text: string, indent: string): string {
    // Blank lines between an item's paragraphs stay empty rather than carrying trailing spaces.
    return text.replaceAll(/\n(?=[^\n])/gu, () => `\n${indent}`);
}

function listItemText(
    list: Extract<MarkdownBlock, { type: 'list' }>,
    item: MarkdownListItem,
    position: number,
): string {
    const marker = list.ordered ? `${(list.start ?? 1) + position}.` : '-';
    const task = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
    const prefix = `${marker} ${task}`;
    return `${prefix}${indentFollowingLines(blocksPlainText(item.blocks), ' '.repeat(marker.length + 1))}`;
}

function blockPlainText(block: MarkdownBlock): string {
    switch (block.type) {
        case 'paragraph':
        case 'heading': {
            return inlinePlainText(block.children, '\n');
        }
        case 'code': {
            return block.value.replace(/\n$/u, '');
        }
        case 'quote': {
            return blocksPlainText(block.children);
        }
        case 'table': {
            return tableToMarkdown(block);
        }
        case 'list': {
            return block.items
                .map((item, position) => listItemText(block, item, position))
                .join('\n');
        }
        case 'rule': {
            return '---';
        }
    }
}

/**
 * The readable text of a run of blocks, such as a quote's content, for the clipboard: blocks separated by a blank line,
 * hard breaks kept as line breaks, list markers and tables kept as Markdown, and every other formatting mark dropped,
 * so a quoted reply pastes as the words it shows.
 */
export function blocksPlainText(blocks: readonly MarkdownBlock[]): string {
    return blocks.map((block) => blockPlainText(block)).join('\n\n');
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
