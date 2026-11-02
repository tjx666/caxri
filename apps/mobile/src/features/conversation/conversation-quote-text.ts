import type { MarkdownBlock } from '@caxri/markdown/blocks';
import { blocksPlainText, parseMarkdownBlocks } from '@caxri/markdown/blocks';
import type { ASTNode } from '@ronradtke/react-native-markdown-display';

/**
 * The `meta` key on a block quote's opening token (`MARKDOWN_IT`) holding the quote's position among the reply's
 * quotes, counted in document order.
 */
export const QUOTE_INDEX = 'quoteIndex';

type QuoteBlock = Extract<MarkdownBlock, { type: 'quote' }>;

/**
 * Every quote in `blocks` in document order: an outer quote before the quotes nested in it, and a quote inside a list
 * item in place. This is the order markdown-it emits `blockquote_open` tokens in, so it matches `QUOTE_INDEX`.
 */
const quotesOf = (blocks: readonly MarkdownBlock[]): QuoteBlock[] =>
    blocks.flatMap((block) => {
        if (block.type === 'quote') return [block, ...quotesOf(block.children)];
        if (block.type === 'list') return block.items.flatMap((item) => quotesOf(item.blocks));
        return [];
    });

/**
 * The position a rendered block quote holds among its reply's quotes, as `MARKDOWN_IT` recorded it.
 */
export const quoteIndexOf = (node: ASTNode): number | undefined => {
    const meta = node.sourceMeta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    const index = meta[QUOTE_INDEX];
    return typeof index === 'number' ? index : undefined;
};

/**
 * What Copy on a reply's `index`th quote puts on the clipboard: the quote's words without its `>` markers, through the
 * same `blocksPlainText` Desktop's Chat copies a quote with. The reply is parsed with the shared parser only when the
 * user taps Copy, so a streaming reply pays nothing for it on each redraw. Unlike Desktop it keeps a single line break
 * as a break, because the phone renders one that way, so the copy pastes with the lines the quote shows.
 */
export const quotePlainText = (source: string, index: number): string => {
    if (index < 0) return '';
    const quote = quotesOf(parseMarkdownBlocks(source, { breaks: true, tables: true })).at(index);
    return quote ? blocksPlainText(quote.children) : '';
};

/**
 * A quote at least this many characters long is worth copying on its own; a shorter single-line one is a phrase a
 * reader can select, and a Copy chip beside it would only squeeze its words.
 */
export const QUOTE_COPY_MIN_CHARACTERS = 120;

/**
 * Node types after which a rendered quote starts a new line.
 */
const LINE_BREAK_TYPES = new Set([
    'bullet_list',
    'code_block',
    'fence',
    'hardbreak',
    'heading1',
    'heading2',
    'heading3',
    'heading4',
    'heading5',
    'heading6',
    'list_item',
    'ordered_list',
    'paragraph',
    'softbreak',
]);

/**
 * The words a rendered quote shows, with a line break wherever the quote starts a new line. It reads the rendered tree
 * so the decision to show Copy costs no re-parse of the reply.
 */
export const quoteNodeText = (node: Pick<ASTNode, 'children' | 'content' | 'type'>): string =>
    `${node.content}${node.children.map((child) => quoteNodeText(child)).join('')}${
        LINE_BREAK_TYPES.has(node.type) ? '\n' : ''
    }`;

/**
 * Whether a quote's text is long enough to earn its own Copy chip: more than one line, or over
 * `QUOTE_COPY_MIN_CHARACTERS` characters.
 */
export const isQuoteWorthCopying = (text: string): boolean => {
    const trimmed = text.trim();
    return trimmed.includes('\n') || trimmed.length > QUOTE_COPY_MIN_CHARACTERS;
};
