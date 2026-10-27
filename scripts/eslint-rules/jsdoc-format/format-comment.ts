/**
 * Per-comment JSDoc formatting ported from `prettier-plugin-jsdoc` 1.8.1 (`src/parser.ts`, `src/stringify.ts`,
 * `src/utils.ts`), MIT License, Copyright (c) 2020 Hossein Mohammadi. See `THIRD_PARTY_NOTICES.md`.
 *
 * Fixed to Caxri's former plugin configuration: `jsdocPrintWidth: 120`, `jsdocCommentLineStrategy: 'keep'`, `tsdoc:
 * true`, and the plugin defaults for every other option.
 */
import type { Spec } from 'comment-parser';
import { parse, tokenizers } from 'comment-parser';

import type { JsdocFormatOptions } from './description';
import { descriptionEndLine, formatDescription } from './description';
import { formatEmbedded } from './embedded-format';
import {
    DESCRIPTION,
    EXAMPLE,
    IMPORT,
    PARAM,
    PRIVATE_REMARKS,
    REMARKS,
    SPACE_TAG,
    TAGS_DEFAULT,
    TAGS_DESCRIPTION_NEEDED,
    TAGS_GROUP_CONDITION,
    TAGS_GROUP_HEAD,
    TAGS_NAMELESS,
    TAGS_ORDER,
    TAGS_PRE_FORMATTED_DESCRIPTION,
    TAGS_SYNONYMS,
    TAGS_TYPELESS,
} from './tags';

/**
 * Width JSDoc content wraps at, before indentation; the former `jsdocPrintWidth`.
 */
const JSDOC_PRINT_WIDTH = 120;

export interface CommentLocation {
    /**
     * Directory whose `bunfig.toml` supplies formatting options for embedded code.
     */
    readonly cwd: string;
    /**
     * Prettier parser name of the owning file (`typescript` or `babel`).
     */
    readonly parser: string;
    /**
     * Spaces and tabs immediately before `/**` on its line, as the plugin measured them.
     */
    readonly precedingSpaces: number;
    readonly precedingTabs: number;
    readonly tabWidth: number;
    /**
     * Source after the comment, used to order `@param` tags by the documented signature.
     */
    readonly textAfter: string;
}

interface TagData {
    default?: string;
    description: string;
    name: string;
    optional: boolean;
    source: Spec['source'];
    tag: string;
    type: string;
}

const SPACE_TAG_DATA: TagData = {
    description: '',
    name: '',
    optional: false,
    source: [],
    tag: SPACE_TAG,
    type: '',
};

const TAGS_ORDER_ENTRIES = Object.entries(TAGS_ORDER);

const isDefaultTag = (tag: string): boolean => TAGS_DEFAULT.includes(tag);

function withoutStrings(type: string, map: (type: string) => string): string {
    const strings: string[] = [];
    let modified = type.replaceAll(/(["'])(?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\r\n])*\1/g, (match) => {
        strings.push(match);
        return `String$${strings.length - 1}$`;
    });
    if (modified.includes('`')) return type;
    modified = map(modified);
    return modified.replaceAll(
        /String\$(\d+)\$/g,
        (_match, index: string) => strings[Number(index)],
    );
}

function convertToModernType(oldType: string): string {
    return withoutStrings(oldType, (input) => {
        let type = input.trim();
        type = type.replaceAll('.<', '<');
        type = type.replaceAll('*', ' any ');
        type = type.replace(/^\?\s*(\w+)$/, '$1 | null').replace(/^(\w+)\s*\?$/, '$1 | null');
        let isChanged = true;
        while (isChanged) {
            isChanged = false;
            type = type.replaceAll(
                // eslint-disable-next-line unicorn/prefer-unicode-code-point-escapes -- A code point escape needs the `u` flag, which changes how astral characters match.
                /(^|[^$\w\xA0-\uFFFF])Array\s*<((?:[^<>=]|=>|=(?!>)|<(?:[^<>=]|=>|=(?!>))+>)+)>/g,
                (_match, prefix: string, inner: string) => {
                    isChanged = true;
                    return `${prefix}(${inner})[]`;
                },
            );
        }
        return type;
    });
}

function formatType(type: string, options: JsdocFormatOptions): string {
    const typeStart = 'type name = ';
    let pretty = type;
    let isRest = false;
    if (pretty.startsWith('...')) {
        isRest = true;
        pretty = `(${pretty.slice(3)})[]`;
    }
    const formatted = formatEmbedded({
        cwd: options.cwd,
        parser: 'typescript',
        printWidth: options.printWidth,
        source: `${typeStart}${pretty}`,
    });
    if (formatted === undefined) return type;
    pretty = formatted
        .slice(typeStart.length)
        .replaceAll(/^\s*/g, '')
        .replaceAll(/[;\n]*$/g, '')
        .replaceAll(/^\|/g, '')
        .trim();
    if (isRest) pretty = `...${pretty.replace(/\[\s*\]$/, '')}`;
    return pretty;
}

function normalizeTags(specs: Spec[]): TagData[] {
    return specs.map((spec) => {
        let tag = spec.tag || '';
        let type = spec.type || '';
        let name = spec.name || '';
        let description = spec.description || '';
        const stickyType = tag.indexOf('{');
        if (stickyType !== -1 && tag.endsWith('}')) {
            type = `${tag.slice(stickyType + 1, -1)} ${type}`;
            tag = tag.slice(0, stickyType);
        }
        tag = tag.trim();
        const lower = tag.toLowerCase();
        const known = TAGS_ORDER_ENTRIES.find(([key]) => key.toLowerCase() === lower);
        if (known) tag = known[0];
        else if (lower in TAGS_SYNONYMS) tag = TAGS_SYNONYMS[lower]!;
        type = type.trim();
        name = name.trim();
        if (name && TAGS_NAMELESS.includes(tag)) {
            description = `${name} ${description}`;
            name = '';
        }
        if (type && TAGS_TYPELESS.includes(tag)) {
            description = `{${type}} ${description}`;
            type = '';
        }
        return {
            default: spec.default?.trim(),
            description,
            name,
            optional: spec.optional,
            source: spec.source,
            tag,
            type,
        };
    });
}

function convertCommentDescToDescTag(blockDescription: string, tags: TagData[]): TagData[] {
    let description = blockDescription;
    const rest = tags.filter((tag) => {
        if (tag.tag.toLowerCase() !== DESCRIPTION) return true;
        if (tag.description.trim()) description += `\n\n${tag.description}`;
        return false;
    });
    if (!description) return rest;
    return [
        { description, name: '', optional: false, source: [], tag: DESCRIPTION, type: '' },
        ...rest,
    ];
}

function parameterNames(list: string): string[] {
    return list
        .split(',')
        .map((parameter) => {
            const trimmed = parameter.trim();
            const colon = trimmed.indexOf(':');
            const name = colon !== -1 ? trimmed.slice(0, colon) : trimmed;
            return name.split(/\s+/, 1)[0].replaceAll(/[{}[\]]/g, '');
        })
        .filter((parameter) => parameter && parameter !== '...');
}

function getParametersOrder(textAfter: string): string[] | undefined {
    const functionMatch = /^\s*function\s+(?:\w+\s*)?\(([^)]*)\)/.exec(textAfter);
    if (functionMatch) return parameterNames(functionMatch[1]);
    const arrowMatch = /^\s*(?:const|let|var)\s+\w+\s*=\s*\(([^)]*)\)\s*=>/.exec(textAfter);
    if (arrowMatch) return parameterNames(arrowMatch[1]);
    const methodMatch = /^\s*\w+\s*\(([^)]*)\)/.exec(textAfter);
    if (methodMatch) return parameterNames(methodMatch[1]);
    return undefined;
}

interface ImportDetails {
    defaultImport: string;
    namedImports: Array<{ alias?: string; name: string }>;
    spec: TagData;
    src: string;
}

function getImportDetails(spec: TagData): ImportDetails | undefined {
    // Verbatim upstream patterns, kept for output parity with `prettier-plugin-jsdoc`; they only see one tag's text.
    /* eslint-disable regexp/no-dupe-characters-character-class, regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking, regexp/no-useless-quantifier, regexp/optimal-quantifier-concatenation */
    const match = /([^\s\\,{\\}]+)?[^\\{\\}]*\{?([^\\{\\}]*)?\}?\s+from\s+[\\'"](\S+)[\\'"]/.exec(
        spec.description,
    );
    if (!match) return undefined;
    const [, defaultImport = '', named = '', source = ''] = match;
    const namedImports = named
        .matchAll(/([^\s\\,{\\}]+)(?:\s+as\s+)?([^\s\\,{\\}]+)?/g)
        .map((typeMatch) => ({ alias: typeMatch[2], name: typeMatch[1] }))
        .toArray();
    /* eslint-enable regexp/no-dupe-characters-character-class, regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking, regexp/no-useless-quantifier, regexp/optimal-quantifier-concatenation */
    return { defaultImport, namedImports, spec, src: source };
}

function writeImportDetailsToSpec({ defaultImport, namedImports, spec, src }: ImportDetails): void {
    namedImports.sort((a, b) => (a.alias ?? a.name).localeCompare(b.alias ?? b.name));
    const clauses: string[] = [];
    if (defaultImport) clauses.push(defaultImport);
    if (namedImports.length > 0) {
        const isMultiLine = namedImports.length > 1;
        const names = namedImports
            .map(({ alias, name }) => {
                const value = alias ? `${name} as ${alias}` : name;
                return isMultiLine ? `  ${value}` : value;
            })
            .join(isMultiLine ? ',\n' : ', ');
        clauses.push(isMultiLine ? `{\n${names}\n}` : `{${names}}`);
    }
    spec.description = `${clauses.join(', ')} from '${src}'`;
}

function getTagOrderWeight(tag: string): number {
    if (tag === DESCRIPTION) return -1;
    return TAGS_ORDER[tag] ?? TAGS_ORDER.other;
}

function sortTags(input: TagData[], parametersOrder: string[] | undefined): TagData[] {
    let canGroupNextTags = false;
    // Widened because TypeScript does not see the assignment inside the `map` callback below.
    let shouldSortAgain = false as boolean;
    const importsBySource: Record<string, ImportDetails[]> = {};
    const sourceByDescription: Record<string, string> = {};
    const groups = input.reduce<TagData[][]>((result, current) => {
        if (result.length === 0 || (canGroupNextTags && TAGS_GROUP_HEAD.includes(current.tag))) {
            canGroupNextTags = false;
            result.push([]);
        }
        if (TAGS_GROUP_CONDITION.includes(current.tag)) canGroupNextTags = true;
        if (current.tag === IMPORT) {
            const details = getImportDetails(current);
            if (details) {
                const existing = importsBySource[details.src] as ImportDetails[] | undefined;
                if (existing) {
                    existing.push(details);
                    return result;
                }
                importsBySource[details.src] = [details];
            }
        }
        result.at(-1)!.push(current);
        return result;
    }, []);
    for (const [source, details] of Object.entries(importsBySource)) {
        const first = details[0].spec;
        const merged = details.reduce<{
            defaultImport: string;
            namedImports: ImportDetails['namedImports'];
        }>(
            (previous, current) => {
                previous.namedImports.push(...current.namedImports);
                if (current.defaultImport) previous.defaultImport = current.defaultImport;
                return previous;
            },
            { defaultImport: '', namedImports: [] },
        );
        writeImportDetailsToSpec({ ...merged, spec: first, src: source });
        sourceByDescription[first.description] = source;
    }
    const tags = groups.flatMap((group, index, all) => {
        group.sort((a, b) => {
            if (
                parametersOrder &&
                parametersOrder.length > 1 &&
                a.tag === PARAM &&
                b.tag === PARAM
            ) {
                const aIndex = parametersOrder.indexOf(a.name);
                const bIndex = parametersOrder.indexOf(b.name);
                return aIndex !== -1 && bIndex !== -1 ? aIndex - bIndex : 0;
            }
            if (a.tag === IMPORT && b.tag === IMPORT) {
                const aSource = sourceByDescription[a.description] ?? a.description;
                // Upstream falls back to `a.description` here too; kept for output parity.
                const bSource = sourceByDescription[b.description] ?? a.description;
                const aRelative = aSource.startsWith('.') ? 1 : 0;
                const bRelative = bSource.startsWith('.') ? 1 : 0;
                return aRelative === bRelative
                    ? aSource.localeCompare(bSource)
                    : aRelative - bRelative;
            }
            return getTagOrderWeight(a.tag) - getTagOrderWeight(b.tag);
        });
        if (all.length - 1 !== index) group.push(SPACE_TAG_DATA);
        if (index > 0 && group[0]?.tag && !TAGS_GROUP_HEAD.includes(group[0].tag))
            shouldSortAgain = true;
        return group;
    });
    return shouldSortAgain ? sortTags(tags, parametersOrder) : tags;
}

function addDefaultValueToDescription(tag: TagData): TagData {
    if (!tag.optional || !tag.default) return tag;
    let description = tag.description.replaceAll(/(?:\s*Default\s+is\s+`.*?`\.?)+/g, '');
    if (description && !/[.\n]$/.test(description)) description += '.';
    description += ` Default is \`${tag.default}\``;
    return { ...tag, description: description.trim() };
}

function assignOptionalAndDefaultToName(data: TagData): TagData {
    let { description, name, type } = data;
    if (isDefaultTag(data.tag)) {
        const sourceLine =
            data.source.find((line) => line.source.includes(`@${data.tag}`))?.source ?? '';
        const tagMatch =
            /@default(?:Value)? (\[.*\]|\{.*\}|\(.*\)|'.*'|".*"|`.*`| \w+)(?: ((?!\*\/).+))?/.exec(
                sourceLine,
            );
        if (tagMatch) {
            [, type = '', description = ''] = tagMatch;
            name = '';
        }
    } else if (data.optional) {
        if (name) name = data.default ? `[${name}=${data.default}]` : `[${name}]`;
        else type += ' | undefined';
    }
    return { ...data, description, name, type };
}

function stringifyTag(
    { description, name, tag, type }: TagData,
    tagIndex: number,
    tags: readonly TagData[],
    options: JsdocFormatOptions,
): string {
    let tagString = '\n';
    if (tag === SPACE_TAG) return tagString;
    const gap = ' ';
    const isUseTagTitle = tag !== DESCRIPTION;
    if (isUseTagTitle) tagString += `@${tag}`;
    if (type) {
        let updatedType = `{${type}}`;
        if (isDefaultTag(tag)) {
            if (type === '[]') updatedType = '[ ]';
            else if (type === '{}') updatedType = '{}';
            // eslint-disable-next-line regexp/no-obscure-range -- Upstream `A-z` also spans `[\]^_` and the backtick; kept for output parity.
            else if (/^\{.*[A-z0-9] ?:.*\}$/.test(type))
                // eslint-disable-next-line regexp/no-obscure-range -- Same upstream range as above.
                updatedType = type.replaceAll(/; ([A-z0-9])/g, ', $1');
            else updatedType = type;
        }
        tagString += gap + updatedType;
    }
    if (name) tagString += `${gap}${name}`;
    if (description) {
        let descriptionString: string;
        if (isUseTagTitle) tagString += gap;
        if (
            TAGS_PRE_FORMATTED_DESCRIPTION.includes(tag) ||
            (TAGS_ORDER[tag] as number | undefined) === undefined
        ) {
            descriptionString = description;
        } else {
            const firstWord = /^\s*(\S+)/.exec(description)?.[1] ?? '';
            const beginningSpace = [DESCRIPTION, EXAMPLE, REMARKS, PRIVATE_REMARKS].includes(tag)
                ? ''
                : '  ';
            if (
                (tag !== DESCRIPTION && tagString.length + firstWord.length > options.printWidth) ||
                [REMARKS, PRIVATE_REMARKS].includes(tag)
            ) {
                descriptionString = `\n${beginningSpace}${formatDescription(tag, description, options, { beginningSpace })}`;
            } else {
                descriptionString = formatDescription(tag, description, options, {
                    beginningSpace,
                    tagStringLength: tagString.length - 1,
                });
            }
        }
        tagString += descriptionString.startsWith('\n')
            ? descriptionString.replaceAll(/^\n\s+\n/g, '\n')
            : descriptionString.trimStart();
    }
    return tagString + descriptionEndLine(tag, tagIndex === tags.length - 1);
}

/**
 * Returns the comment value (the text between `/*` and `*\/`) the plugin would print for a JSDoc comment, `''` when the
 * plugin would remove an empty comment, or `undefined` when the comment is not a JSDoc block.
 */
export function formatJsdocCommentValue(
    value: string,
    location: CommentLocation,
): string | undefined {
    const normalizedValue = value.replaceAll(/^(\*+)/g, '*');
    const commentString = `/*${normalizedValue.replaceAll(/\r\n?/g, '\n')}*/`;
    if (!/^\/\*\*[\s\S]+?\*\/$/.test(commentString)) return undefined;
    const parsed = parse(commentString, {
        spacing: 'preserve',
        tokenizers: [
            tokenizers.tag(),
            (spec) => (isDefaultTag(spec.tag) ? spec : tokenizers.type('preserve')(spec)),
            tokenizers.name(),
            tokenizers.description('preserve'),
        ],
    }).at(0);
    if (!parsed) return '';
    const commentWidth =
        JSDOC_PRINT_WIDTH -
        (location.precedingSpaces + location.precedingTabs * location.tabWidth) -
        ' * '.length;
    const options: JsdocFormatOptions = {
        cwd: location.cwd,
        parser: location.parser,
        printWidth: commentWidth,
        tabWidth: location.tabWidth,
        useTabs: false,
    };
    let tags = convertCommentDescToDescTag(
        parsed.description || '',
        normalizeTags(parsed.tags),
    ).map((tag) => {
        if (!tag.type) return tag;
        let { optional } = tag;
        const type = convertToModernType(
            tag.type.replace(/=$/, () => {
                optional = true;
                return '';
            }),
        );
        return { ...tag, optional, type };
    });
    tags = sortTags(tags, getParametersOrder(location.textAfter))
        .map(addDefaultValueToDescription)
        .map(assignOptionalAndDefaultToName)
        .map((tag) => (tag.type ? { ...tag, type: formatType(tag.type, options) } : tag))
        .filter(({ description, tag }) => description || !TAGS_DESCRIPTION_NEEDED.includes(tag));
    let content = tags.map((tag, index) => stringifyTag(tag, index, tags, options)).join('');
    content = content.trimEnd();
    if (!content) return '';
    // `keep` preserves a single-line comment. Upstream also keeps it single-line after wrapping its content, which
    // prints continuation lines without a leading `*`; expand such a comment to the block form instead.
    if (!normalizedValue.includes('\n') && !content.trim().includes('\n'))
        return `* ${content.trim()} `;
    return `*${content.replaceAll(/(\n(?!$))/g, '\n * ')}\n `;
}
