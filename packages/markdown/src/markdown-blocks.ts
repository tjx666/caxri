import type { Token } from 'markdown-it';
import createMarkdownIt from 'markdown-it';

/**
 * Inline content of a {@link MarkdownBlock}. Every variant carries plain text only, so a host renders it as text nodes.
 */
export type MarkdownInline =
    | { type: 'text'; value: string }
    | { type: 'code'; value: string }
    | { type: 'break' }
    | { type: 'strong'; children: MarkdownInline[] }
    | { type: 'emphasis'; children: MarkdownInline[] }
    | { type: 'strikethrough'; children: MarkdownInline[] }
    /**
     * `href` is present only for an absolute HTTP(S) destination; any other target keeps its text but is not a link.
     */
    | { type: 'link'; href?: string; children: MarkdownInline[] };

/**
 * A closed, HTML-free subset of Markdown for small untrusted surfaces such as hover cards.
 */
export type MarkdownBlock =
    | { type: 'paragraph'; children: MarkdownInline[] }
    | { type: 'heading'; children: MarkdownInline[] }
    | { type: 'code'; value: string }
    | { type: 'quote'; children: MarkdownBlock[] }
    | { type: 'list'; ordered: boolean; items: MarkdownBlock[][] }
    | { type: 'rule' };

/**
 * `html: true` is deliberate: with raw HTML disabled, markdown-it re-emits `<sub>` and friends as literal text, while
 * enabling it yields `html_inline` / `html_block` tokens this converter can drop. Nothing here ever emits HTML.
 */
const engine = createMarkdownIt({ html: true, linkify: true, typographer: false });

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
function inlineLeaf(token: Token): MarkdownInline | undefined {
    switch (token.type) {
        case 'text':
        case 'image': {
            return token.content ? { type: 'text', value: token.content } : undefined;
        }
        case 'code_inline': {
            return { type: 'code', value: token.content };
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

function convertInline(tokens: readonly Token[]): MarkdownInline[] {
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
                    ? { type: 'link', href: safeHref(token.attrGet('href')), children }
                    : { type: container, children },
            );
            stack.push(children);
        } else if (inlineClosers.has(token.type)) {
            if (stack.length > 1) stack.pop();
        } else {
            const leaf = inlineLeaf(token);
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

function listItems(tokens: readonly Token[], start: number, end: number): MarkdownBlock[][] {
    const items: MarkdownBlock[][] = [];
    let cursor = start + 1;
    while (cursor < end) {
        const itemEnd = closingIndex(tokens, cursor);
        items.push(convertBlocks(tokens.slice(cursor + 1, itemEnd)));
        cursor = itemEnd + 1;
    }
    return items;
}

/**
 * Converts the block that starts at `index` and returns the index after it. A block with no visible content yields no
 * node.
 */
function convertBlockAt(
    tokens: readonly Token[],
    index: number,
): { block?: MarkdownBlock; next: number } {
    const token = tokens[index]!;
    switch (token.type) {
        case 'paragraph_open':
        case 'heading_open': {
            const end = closingIndex(tokens, index);
            const children = tokens
                .slice(index + 1, end)
                .flatMap((inline) => convertInline(inline.children ?? []));
            const type = token.type === 'heading_open' ? 'heading' : 'paragraph';
            return { block: children.length > 0 ? { type, children } : undefined, next: end + 1 };
        }
        case 'blockquote_open': {
            const end = closingIndex(tokens, index);
            const children = convertBlocks(tokens.slice(index + 1, end));
            return {
                block: children.length > 0 ? { type: 'quote', children } : undefined,
                next: end + 1,
            };
        }
        case 'bullet_list_open':
        case 'ordered_list_open': {
            const end = closingIndex(tokens, index);
            const isOrdered = token.type === 'ordered_list_open';
            return {
                block: { type: 'list', ordered: isOrdered, items: listItems(tokens, index, end) },
                next: end + 1,
            };
        }
        case 'fence':
        case 'code_block': {
            return {
                block: { type: 'code', value: token.content.replace(/\n$/u, '') },
                next: index + 1,
            };
        }
        case 'hr': {
            return { block: { type: 'rule' }, next: index + 1 };
        }
        default: {
            /**
             * `html_block` is dropped. Tables are skipped by jumping past their closing token: a hover card is too
             * narrow to lay one out, and the full text stays one click away at the source.
             */
            return { next: (token.nesting === 1 ? closingIndex(tokens, index) : index) + 1 };
        }
    }
}

function convertBlocks(tokens: readonly Token[]): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    let index = 0;
    while (index < tokens.length) {
        const { block, next } = convertBlockAt(tokens, index);
        if (block) blocks.push(block);
        index = next;
    }
    return blocks;
}

/**
 * Parses untrusted Markdown into an HTML-free block tree. Raw HTML is dropped, images collapse to alt text, and only
 * absolute HTTP(S) links keep a destination, so a host can render the result with text nodes and no sanitizer.
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
    return convertBlocks(engine.parse(source, {}));
}
