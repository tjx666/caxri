import type { Token } from 'markdown-it';
import createMarkdownIt from 'markdown-it';

import { fileLinkTarget, fileReferenceTarget } from './file-reference.js';

/**
 * Inline content of a {@link MarkdownBlock}. Every variant carries plain text only, so a host renders it as text nodes.
 */
export type MarkdownInline =
    | { type: 'text'; value: string }
    /**
     * `file` is the path-like reference the span names, present only when the caller opts in with `fileLinks`.
     */
    | { type: 'code'; value: string; file?: string }
    | { type: 'break' }
    | { type: 'strong'; children: MarkdownInline[] }
    | { type: 'emphasis'; children: MarkdownInline[] }
    | { type: 'strikethrough'; children: MarkdownInline[] }
    /**
     * `href` is present only for an absolute HTTP(S) destination. `file` is a local path destination, kept only when
     * the caller opts in with `fileLinks`; the host resolves it against its own authorized roots. Any other target
     * keeps its text but is not a link.
     */
    | { type: 'link'; href?: string; file?: string; children: MarkdownInline[] };

/**
 * One list entry. `checked` is present only for a GitHub-style task item (`- [ ]` / `- [x]`).
 */
export interface MarkdownListItem {
    blocks: MarkdownBlock[];
    checked?: boolean;
}

/**
 * A closed, HTML-free subset of Markdown for untrusted surfaces such as hover cards and Agent Chat messages.
 */
export type MarkdownBlock =
    | { type: 'paragraph'; children: MarkdownInline[] }
    | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
    /**
     * `language` is the fence's info string up to its first space, when one was given.
     */
    | { type: 'code'; value: string; language?: string }
    | { type: 'quote'; children: MarkdownBlock[] }
    /**
     * Present only when the caller opts in with `tables`. Every row carries one cell per header column.
     */
    | {
          type: 'table';
          align: Array<'center' | 'left' | 'right' | undefined>;
          header: MarkdownInline[][];
          rows: MarkdownInline[][][];
      }
    /**
     * `start` is present only for an ordered list that does not begin at 1.
     */
    | { type: 'list'; ordered: boolean; start?: number; items: MarkdownListItem[] }
    | { type: 'rule' };

export interface MarkdownBlockOptions {
    /**
     * Keep tables. Off by default: a hover card is too narrow to lay one out and its full text is one click away at the
     * source, while a conversation transcript has room and no other place to show it.
     */
    tables?: boolean;
    /**
     * Keep local path destinations and mark path-like inline code (`src/a.ts:12`) as file references. Off by default:
     * only a host that can resolve a path against an authorized root, such as an Agent Chat bound to a Terminal, opts
     * in.
     */
    fileLinks?: boolean;
}

/**
 * `html: true` is deliberate: with raw HTML disabled, markdown-it re-emits `<sub>` and friends as literal text, while
 * enabling it yields `html_inline` / `html_block` tokens this converter can drop. Nothing here ever emits HTML.
 */
const engine = createMarkdownIt({ html: true, linkify: true, typographer: false });

/**
 * Markdown-it refuses `file:` destinations outright, which would leave an Agent's `[a.ts](file:///abs/a.ts)` citation
 * as literal source. Allowing the scheme only lets it become a link token; {@link fileLinkTarget} still decides whether
 * it is kept, and nothing here ever emits it as an `href`.
 */
const validateLink = engine.validateLink.bind(engine);
engine.validateLink = (url) => /^file:/iu.test(url.trim()) || validateLink(url);

/**
 * Markdown-it has already rejected `javascript:`-style targets and normalized the URL. The host's external-link policy
 * validates again on open; this only decides whether the text is presented as a link at all.
 */
const HTTP_URL = /^https?:\/\/[^\s/]/i;

function safeHref(value: string | number | null): string | undefined {
    return typeof value === 'string' && HTTP_URL.test(value) ? value : undefined;
}

const inlineContainers = new Map<string, 'emphasis' | 'link' | 'strikethrough' | 'strong'>([
    ['em_open', 'emphasis'],
    ['link_open', 'link'],
    ['s_open', 'strikethrough'],
    ['strong_open', 'strong'],
]);

const inlineClosers = new Set(['em_close', 'link_close', 's_close', 'strong_close']);

/**
 * Maps one leaf inline token to its node. `html_inline` and any unknown token map to nothing, so they are dropped
 * rather than shown as source; an image is reduced to its alt text because hover cards never load remote content.
 */
function inlineLeaf(token: Token, options: MarkdownBlockOptions): MarkdownInline | undefined {
    switch (token.type) {
        case 'text':
        case 'image': {
            return token.content ? { type: 'text', value: token.content } : undefined;
        }
        case 'code_inline': {
            const file = options.fileLinks ? fileReferenceTarget(token.content) : undefined;
            return { type: 'code', value: token.content, ...(file && { file }) };
        }
        case 'softbreak': {
            return { type: 'text', value: ' ' };
        }
        case 'hardbreak': {
            return { type: 'break' };
        }
        default: {
            return undefined;
        }
    }
}

function linkNode(token: Token, options: MarkdownBlockOptions, children: MarkdownInline[]) {
    const destination = token.attrGet('href');
    const href = safeHref(destination);
    const file =
        typeof destination === 'string' && !href && options.fileLinks
            ? fileLinkTarget(destination)
            : undefined;
    return { type: 'link' as const, href, ...(file && { file }), children };
}

function convertInline(tokens: readonly Token[], options: MarkdownBlockOptions): MarkdownInline[] {
    const root: MarkdownInline[] = [];
    const stack: MarkdownInline[][] = [root];
    const push = (node: MarkdownInline) => {
        const current = stack.at(-1)!;
        const previous = current.at(-1);
        /**
         * Adjacent text merges so dropped HTML and image alt text do not fragment a sentence into many nodes.
         */
        if (node.type === 'text' && previous?.type === 'text') previous.value += node.value;
        else current.push(node);
    };
    for (const token of tokens) {
        const container = inlineContainers.get(token.type);
        if (container) {
            const children: MarkdownInline[] = [];
            push(
                container === 'link'
                    ? linkNode(token, options, children)
                    : { type: container, children },
            );
            stack.push(children);
        } else if (inlineClosers.has(token.type)) {
            if (stack.length > 1) stack.pop();
        } else {
            const leaf = inlineLeaf(token, options);
            if (leaf) push(leaf);
        }
    }
    return trimInline(root);
}

/**
 * Removes whitespace left at the edges after dropped HTML, and empty containers such as a badge link whose only child
 * was an image without alt text.
 */
function trimInline(nodes: MarkdownInline[]): MarkdownInline[] {
    const kept = nodes.filter(
        (node) => !('children' in node) || (node.children = trimInline(node.children)).length > 0,
    );
    const first = kept[0];
    if (first?.type === 'text') first.value = first.value.trimStart();
    const last = kept.at(-1);
    if (last?.type === 'text') last.value = last.value.trimEnd();
    return kept.filter((node) => node.type !== 'text' || node.value.length > 0);
}

function closingIndex(tokens: readonly Token[], start: number): number {
    const open = tokens[start]!;
    for (let index = start + 1; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token.level === open.level && token.nesting === -1) return index;
    }
    return tokens.length;
}

function cellAlign(token: Token): 'center' | 'left' | 'right' | undefined {
    const style = token.attrGet('style');
    const match =
        typeof style === 'string' ? /text-align:\s*(center|left|right)/u.exec(style) : null;
    return match?.[1] as 'center' | 'left' | 'right' | undefined;
}

interface TableRow {
    cells: MarkdownInline[][];
    align: Array<ReturnType<typeof cellAlign>>;
}

function pushCell(
    row: TableRow | undefined,
    open: Token,
    inline: Token | undefined,
    options: MarkdownBlockOptions,
): void {
    row?.cells.push(inline?.type === 'inline' ? convertInline(inline.children ?? [], options) : []);
    row?.align.push(cellAlign(open));
}

/**
 * Reads a table's rows between `start` and `end`. Each row is padded or cut to the header's width so a host can lay the
 * grid out without checking ragged rows.
 */
function convertTable(
    tokens: readonly Token[],
    start: number,
    end: number,
    options: MarkdownBlockOptions,
): Extract<MarkdownBlock, { type: 'table' }> {
    const rows: TableRow[] = [];
    let isHeader = false;
    let headerCount = 0;
    for (let index = start + 1; index < end; index += 1) {
        const token = tokens[index]!;
        if (token.type === 'thead_open' || token.type === 'thead_close') {
            isHeader = token.type === 'thead_open';
            continue;
        }
        if (token.type === 'tr_open') {
            rows.push({ cells: [], align: [] });
            if (isHeader) headerCount += 1;
            continue;
        }
        if (token.type === 'th_open' || token.type === 'td_open') {
            pushCell(rows.at(-1), token, tokens[index + 1], options);
        }
    }
    const header = rows.slice(0, headerCount).at(-1) ?? { cells: [], align: [] };
    const width = header.cells.length;
    return {
        type: 'table',
        align: header.align,
        header: header.cells,
        rows: rows
            .slice(headerCount)
            .map(({ cells }) => Array.from({ length: width }, (_, column) => cells[column] ?? [])),
    };
}

const TASK_MARKER = /^\[([ x])\](?:\s+|$)/iu;

/**
 * Lifts a GitHub task marker (`[ ]` / `[x]`) off the start of an item's first paragraph. markdown-it has no task-list
 * rule, so the marker arrives as ordinary leading text.
 */
function taskItem(blocks: MarkdownBlock[]): MarkdownListItem {
    const [first] = blocks;
    const lead = first?.type === 'paragraph' ? first.children.at(0) : undefined;
    const marker = lead?.type === 'text' ? TASK_MARKER.exec(lead.value) : null;
    if (!marker || first?.type !== 'paragraph' || lead?.type !== 'text') return { blocks };
    const rest = lead.value.slice(marker[0].length);
    const children = rest
        ? [{ ...lead, value: rest }, ...first.children.slice(1)]
        : first.children.slice(1);
    return {
        blocks:
            children.length > 0 ? [{ ...first, children }, ...blocks.slice(1)] : blocks.slice(1),
        checked: marker[1] !== ' ',
    };
}

function listItems(
    tokens: readonly Token[],
    start: number,
    end: number,
    options: MarkdownBlockOptions,
): MarkdownListItem[] {
    const items: MarkdownListItem[] = [];
    let cursor = start + 1;
    while (cursor < end) {
        const itemEnd = closingIndex(tokens, cursor);
        const blocks = convertBlocks(tokens.slice(cursor + 1, itemEnd), options);
        items.push(taskItem(blocks));
        cursor = itemEnd + 1;
    }
    return items;
}

function headingLevel(token: Token): 1 | 2 | 3 | 4 | 5 | 6 {
    const level = Number(token.tag.slice(1));
    return (level >= 1 && level <= 6 ? level : 6) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Converts the block that starts at `index` and returns the index after it. A block with no visible content yields no
 * node.
 */
function convertBlockAt(
    tokens: readonly Token[],
    index: number,
    options: MarkdownBlockOptions,
): { block?: MarkdownBlock; next: number } {
    const token = tokens[index]!;
    switch (token.type) {
        case 'paragraph_open':
        case 'heading_open': {
            const end = closingIndex(tokens, index);
            const children = tokens
                .slice(index + 1, end)
                .flatMap((inline) => convertInline(inline.children ?? [], options));
            if (children.length === 0) return { next: end + 1 };
            return {
                block:
                    token.type === 'heading_open'
                        ? { type: 'heading', level: headingLevel(token), children }
                        : { type: 'paragraph', children },
                next: end + 1,
            };
        }
        case 'blockquote_open': {
            const end = closingIndex(tokens, index);
            const children = convertBlocks(tokens.slice(index + 1, end), options);
            return {
                block: children.length > 0 ? { type: 'quote', children } : undefined,
                next: end + 1,
            };
        }
        case 'bullet_list_open':
        case 'ordered_list_open': {
            const end = closingIndex(tokens, index);
            const isOrdered = token.type === 'ordered_list_open';
            const start = isOrdered ? Number(token.attrGet('start') ?? 1) : 1;
            return {
                block: {
                    type: 'list',
                    ordered: isOrdered,
                    ...(Number.isSafeInteger(start) && start !== 1 && { start }),
                    items: listItems(tokens, index, end, options),
                },
                next: end + 1,
            };
        }
        case 'fence':
        case 'code_block': {
            const language = token.info.trim().split(/\s/u, 1)[0];
            return {
                block: {
                    type: 'code',
                    value: token.content.replace(/\n$/u, ''),
                    ...(language && { language }),
                },
                next: index + 1,
            };
        }
        case 'table_open': {
            const end = closingIndex(tokens, index);
            return {
                block: options.tables ? convertTable(tokens, index, end, options) : undefined,
                next: end + 1,
            };
        }
        case 'hr': {
            return { block: { type: 'rule' }, next: index + 1 };
        }
        default: {
            /**
             * `html_block` and any unknown container are dropped by jumping past their closing token.
             */
            return { next: (token.nesting === 1 ? closingIndex(tokens, index) : index) + 1 };
        }
    }
}

function convertBlocks(tokens: readonly Token[], options: MarkdownBlockOptions): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    let index = 0;
    while (index < tokens.length) {
        const { block, next } = convertBlockAt(tokens, index, options);
        if (block) blocks.push(block);
        index = next;
    }
    return blocks;
}

/**
 * Parses untrusted Markdown into an HTML-free block tree. Raw HTML is dropped, images collapse to alt text, and only
 * absolute HTTP(S) links keep a destination, so a host can render the result with text nodes and no sanitizer.
 */
export function parseMarkdownBlocks(
    source: string,
    options: MarkdownBlockOptions = {},
): MarkdownBlock[] {
    return convertBlocks(engine.parse(source, {}), options);
}
