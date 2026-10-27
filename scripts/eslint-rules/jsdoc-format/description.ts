/**
 * Markdown-aware JSDoc description formatting ported from `prettier-plugin-jsdoc` 1.8.1 (`src/descriptionFormatter.ts`,
 * `src/utils.ts`), MIT License, Copyright (c) 2020 Hossein Mohammadi. See `THIRD_PARTY_NOTICES.md`.
 *
 * The port keeps the plugin's output for Caxri's former configuration (`tsdoc: true`, capitalized descriptions, greedy
 * wrapping, indented code blocks) so existing comments stay byte-for-byte stable. Prettier calls became synchronous
 * `bun fmt` calls through {@link formatEmbedded}.
 */
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

import { formatEmbedded } from './embedded-format';
import { DESCRIPTION, EXAMPLE, TAGS_PRE_FORMATTED_DESCRIPTION, TODO } from './tags';

export interface JsdocFormatOptions {
    /**
     * Directory whose `bunfig.toml` supplies formatting options for embedded code.
     */
    readonly cwd: string;
    /**
     * Prettier parser name of the file that owns the comment (`typescript` or `babel`).
     */
    readonly parser: string;
    /**
     * Width available to comment content: the JSDoc print width minus indentation and the `*` prefix.
     */
    readonly printWidth: number;
    readonly tabWidth: number;
    readonly useTabs: boolean;
}

interface DescriptionLayout {
    /**
     * Characters the tag title, type, and name already occupy on the description's first line.
     */
    readonly tagStringLength?: number;
    /**
     * Indentation prefixed to every description line after the first.
     */
    readonly beginningSpace: string;
}

const TABLE = '2@^5!~#sdE!_TABLE';

/**
 * Table placeholder state; `costumeType` is the upstream property name.
 */
type MarkedNode = Nodes & { costumeType?: string };

function parserSynonyms(lang: string): string[] {
    switch (lang) {
        case 'js':
        case 'javascript':
        case 'jsx':
            return ['babel', 'babel-flow', 'vue'];
        case 'ts':
        case 'typescript':
        case 'tsx':
            return ['typescript', 'babel-ts', 'angular'];
        case 'json':
        case 'css':
            return ['css'];
        case 'less':
            return ['less'];
        case 'scss':
            return ['scss'];
        case 'html':
            return ['html'];
        case 'yaml':
            return ['yaml'];
        default:
            return ['babel'];
    }
}

export function descriptionEndLine(tag: string, isEndTag: boolean): string {
    return !isEndTag && [DESCRIPTION, EXAMPLE, TODO].includes(tag) ? '\n' : '';
}

function capitalizer(text: string): string {
    if (!text) return text;
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('- ')) return text.slice(0, 2) + capitalizer(text.slice(2));
    return text[0].toUpperCase() + text.slice(1);
}

/**
 * Formats code the way `prettier-plugin-jsdoc`'s `formatCode` does, keeping unparsable code as written.
 */
function formatCode(
    code: string,
    beginningSpace: string,
    options: JsdocFormatOptions & {
        readonly codeParser?: string;
        readonly keepUnparsableIndent?: boolean;
    },
): string {
    let result = code;
    if (
        result
            .split('\n')
            .slice(1)
            .every((line) => !line.trim() || line.startsWith(beginningSpace))
    ) {
        result = result.replaceAll(
            new RegExp(`\n${beginningSpace.replaceAll('\t', String.raw`[\t]`)}`, 'g'),
            '\n',
        );
    }
    const formatted = formatEmbedded({
        cwd: options.cwd,
        parser: result.trimStart().startsWith('{')
            ? 'json'
            : (options.codeParser ?? options.parser),
        printWidth: options.printWidth - 4,
        source: result || '',
    });
    if (formatted !== undefined) return formatted.replaceAll(/^|\n/g, () => `\n${beginningSpace}`);
    result = `\n${result
        .split('\n')
        .map((line) => `${beginningSpace}${options.keepUnparsableIndent ? line : line.trim()}`)
        .join('\n')}\n`;
    return result.replaceAll(/^\n\s+\n/g, '\n');
}

function breakDescriptionToLines(
    content: string,
    maxWidth: number,
    beginningSpace: string,
): string {
    let rest = content.trim();
    if (!rest) return rest;
    let result = '';
    while (rest.length > maxWidth) {
        let sliceIndex = rest.lastIndexOf(' ', rest.startsWith('\n') ? maxWidth + 1 : maxWidth);
        if (sliceIndex <= beginningSpace.length)
            sliceIndex = rest.indexOf(' ', beginningSpace.length + 1);
        if (sliceIndex === -1) sliceIndex = rest.length;
        result += rest.slice(0, sliceIndex);
        rest = rest.slice(sliceIndex + 1);
        if (rest) rest = `\n${beginningSpace}${rest}`;
    }
    result += rest;
    return `${beginningSpace}${result}`;
}

export function formatDescription(
    tag: string,
    input: string,
    options: JsdocFormatOptions,
    layout: DescriptionLayout,
): string {
    if (!input) return input;
    const { printWidth } = options;
    const { tagStringLength = 0, beginningSpace } = layout;
    const shouldCapitalize = !TAGS_PRE_FORMATTED_DESCRIPTION.includes(tag);
    let text = input.replaceAll(/^(\d+)-[\s|]+/g, '$1. ');
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- Verbatim upstream pattern, kept for output parity; inputs are single comments.
    text = text.replaceAll(/\n+(\s*\d+)-\s+/g, '\n$1. ');
    const codeBlocks = [
        ...text.matchAll(/```\S*\n[\s\S]+?```/g),
        ...text.matchAll(/^\r?\n(?:(?: {4}|\t).*(?:\r?\n|$))+/gm),
    ];
    const tables: string[] = [];
    text = text.replaceAll(
        /((\n|^)\|[\s\S]*?)((\n[^|])|$)/g,
        (match: string, _1: string, _2: string, tail: string, _4: string, offset: number) => {
            for (const block of codeBlocks) {
                if (
                    block.index <= offset + 1 &&
                    offset + match.length + 1 <= block.index + block[0].length
                ) {
                    return match;
                }
            }
            tables.push(tail ? match.slice(0, -1) : match);
            return `\n\n${TABLE}\n\n${tail ? tail.slice(1) : ''}`;
        },
    );
    if (shouldCapitalize) text = capitalizer(text);
    text = `${tagStringLength ? `${'!'.repeat(tagStringLength - 1)}?` : ''}${text.startsWith('```') ? '\n' : ''}${text}`;
    text = text.replaceAll(new RegExp(String.raw`\n[ ]{${beginningSpace.length}}`, 'g'), '\n');
    let tableIndex = 0;

    function stringifyLeaf(node: MarkedNode, intention: string, parent: MarkedNode | null): string {
        if (node.type === 'inlineCode') return `\`${node.value}\``;
        if (node.type === 'code') {
            let result = node.value || '';
            let codeIntention = intention;
            if (result) {
                if (node.lang) {
                    const supportParsers = parserSynonyms(node.lang.toLowerCase());
                    const codeParser = supportParsers.includes(options.parser)
                        ? options.parser
                        : (supportParsers[0] ?? node.lang);
                    result = formatCode(result, intention, {
                        ...options,
                        codeParser,
                        keepUnparsableIndent: true,
                    });
                } else {
                    codeIntention = intention + ' '.repeat(4);
                    result = formatCode(result, codeIntention, {
                        ...options,
                        keepUnparsableIndent: true,
                    });
                }
            }
            const isAddFence = !!node.lang;
            result = isAddFence ? result : result.trimEnd();
            if (!result) return '';
            return isAddFence
                ? `\n\n${codeIntention}\`\`\`${node.lang ?? ''}${result}\`\`\``
                : `\n${result}`;
        }
        if ('value' in node && node.value === TABLE) {
            if (parent) parent.costumeType = TABLE;
            if (tables.length > 0) {
                let result = tables[tableIndex] ?? '';
                tableIndex++;
                if (result) {
                    result = (
                        formatEmbedded({
                            cwd: options.cwd,
                            parser: 'markdown',
                            printWidth,
                            source: result,
                        }) ?? result
                    ).trim();
                }
                return result
                    ? `\n\n${intention}${result.split('\n').join(`\n${intention}`)}`
                    : node.value;
            }
        }
        if (node.type === 'break') return '\\\n';
        if ('value' in node && node.value) return node.value;
        if ('title' in node && node.title) return node.title;
        if ('alt' in node && node.alt) return node.alt;
        return '';
    }

    function formatParagraphText(paragraph: string, intention: string): string {
        const links: string[] = [];
        let line = paragraph.replaceAll(
            /\{@(link|linkcode|linkplain)\s(([^{}])*)\}/g,
            (_match: string, linkTag: string, link: string) => {
                links.push(link);
                return `{@${linkTag}${'_'.repeat(link.length)}}`;
            },
        );
        line = line.replaceAll(/\s+/g, ' ');
        if (shouldCapitalize) line = capitalizer(line);
        let result = breakDescriptionToLines(line, printWidth, intention);
        result = result.replaceAll(
            /\{@(link|linkcode|linkplain)(_+)\}/g,
            (original: string, linkTag: string, underline: string) => {
                const link = links.at(0);
                if (link?.length === underline.length) {
                    links.shift();
                    return `{@${linkTag} ${link}}`;
                }
                return original;
            },
        );
        return result;
    }

    function stringify(node: MarkedNode, intention: string, parent: MarkedNode | null): string {
        if (!('children' in node) || !Array.isArray(node.children))
            return stringifyLeaf(node, intention, parent);
        const container = node;
        return container.children
            .map((child: MarkedNode, index: number) => {
                switch (child.type) {
                    case 'listItem': {
                        let marker = `\n${intention}- `;
                        if (container.type === 'list' && typeof container.start === 'number') {
                            marker = `\n${intention}${index + (container.start ?? 1)}. `;
                        }
                        const itemIntention = intention + ' '.repeat(marker.length - 1);
                        return `${marker}${stringify(child, itemIntention, container).trim()}`;
                    }
                    case 'list': {
                        const end =
                            tag !== DESCRIPTION &&
                            container.type === 'root' &&
                            index === container.children.length - 1
                                ? '\n'
                                : '';
                        return `\n${stringify(child, intention, container)}${end}`;
                    }
                    case 'paragraph': {
                        const paragraph = stringify(child, intention, parent);
                        if (child.costumeType === TABLE) return paragraph;
                        return `\n\n${paragraph
                            .split('\\\n')
                            .map((part) => formatParagraphText(part, intention))
                            .join('\\\n')}`;
                    }
                    case 'strong':
                        return `**${stringify(child, intention, container)}**`;
                    case 'emphasis':
                        return `_${stringify(child, intention, container)}_`;
                    case 'heading':
                        return `\n\n${intention}${'#'.repeat(child.depth)} ${stringify(child, intention, container)}`;
                    case 'link':
                    case 'image':
                        return `[${stringify(child, intention, container)}](${child.url})`;
                    case 'linkReference':
                        return `[${stringify(child, intention, container)}][${child.label}]`;
                    case 'definition':
                        return `\n\n[${child.label}]: ${child.url}`;
                    case 'blockquote': {
                        const paragraph = stringify(child, '', container);
                        return `\n\n> ${paragraph.trim().replaceAll(/\n+/g, (newlines) => `${newlines}${intention}> `)}`;
                    }
                    default:
                        return stringify(child, intention, container);
                }
            })
            .join('');
    }

    let result = stringify(fromMarkdown(text), beginningSpace, null);
    result = result.replaceAll(/^\s+/g, '');
    result = result.replaceAll(/^(!+\?)/g, '');
    return result;
}
