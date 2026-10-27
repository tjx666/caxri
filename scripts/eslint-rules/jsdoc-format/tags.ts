/**
 * Tag names and tag roles ported from `prettier-plugin-jsdoc` 1.8.1 (`src/tags.ts`, `src/roles.ts`), MIT License,
 * Copyright (c) 2020 Hossein Mohammadi. See `THIRD_PARTY_NOTICES.md`.
 */

const ABSTRACT = 'abstract';
const ASYNC = 'async';
const AUGMENTS = 'augments';
const AUTHOR = 'author';
const BORROWS = 'borrows';
const CALLBACK = 'callback';
const CATEGORY = 'category';
const CLASS = 'class';
const CONSTANT = 'constant';
const DEFAULT = 'default';
const DEFAULT_VALUE = 'defaultValue';
const DEPRECATED = 'deprecated';
export const DESCRIPTION = 'description';
export const EXAMPLE = 'example';
const EXTENDS = 'extends';
const EXTERNAL = 'external';
const FILE = 'file';
const FIRES = 'fires';
const FLOW = 'flow';
const FUNCTION = 'function';
const IGNORE = 'ignore';
export const IMPORT = 'import';
const LICENSE = 'license';
const MEMBER = 'member';
const MEMBEROF = 'memberof';
const MODULE = 'module';
const NAMESPACE = 'namespace';
const OVERLOAD = 'overload';
const OVERRIDE = 'override';
export const PARAM = 'param';
const PRIVATE = 'private';
export const PRIVATE_REMARKS = 'privateRemarks';
const PROPERTY = 'property';
const PROVIDES_MODULE = 'providesModule';
export const REMARKS = 'remarks';
const RETURNS = 'returns';
const SATISFIES = 'satisfies';
const SEE = 'see';
const SINCE = 'since';
const TEMPLATE = 'template';
const THIS = 'this';
const THROWS = 'throws';
export const TODO = 'todo';
const TYPE = 'type';
const TYPE_PARAM = 'typeParam';
const TYPEDEF = 'typedef';
const VERSION = 'version';
const YIELDS = 'yields';

/**
 * Marker tag the stringifier prints as one blank comment line.
 */
export const SPACE_TAG = 'this_is_for_space';

export const TAGS_SYNONYMS: Readonly<Record<string, string>> = {
    arg: PARAM,
    argument: PARAM,
    const: CONSTANT,
    constructor: CLASS,
    desc: DESCRIPTION,
    emits: FIRES,
    examples: EXAMPLE,
    exception: THROWS,
    fileoverview: FILE,
    func: FUNCTION,
    hidden: IGNORE,
    host: EXTERNAL,
    method: FUNCTION,
    overview: FILE,
    params: PARAM,
    prop: PROPERTY,
    return: RETURNS,
    var: MEMBER,
    virtual: ABSTRACT,
    yield: YIELDS,
};

export const TAGS_DEFAULT: readonly string[] = [DEFAULT, DEFAULT_VALUE];

export const TAGS_NAMELESS: readonly string[] = [
    BORROWS,
    CATEGORY,
    DEPRECATED,
    DESCRIPTION,
    EXAMPLE,
    EXTENDS,
    LICENSE,
    IMPORT,
    MODULE,
    NAMESPACE,
    OVERLOAD,
    OVERRIDE,
    PRIVATE_REMARKS,
    REMARKS,
    RETURNS,
    SINCE,
    THIS,
    THROWS,
    TODO,
    YIELDS,
    FILE,
    ...TAGS_DEFAULT,
];

export const TAGS_TYPELESS: readonly string[] = [
    BORROWS,
    DEPRECATED,
    DESCRIPTION,
    EXAMPLE,
    IGNORE,
    IMPORT,
    LICENSE,
    MODULE,
    NAMESPACE,
    OVERLOAD,
    OVERRIDE,
    PRIVATE_REMARKS,
    REMARKS,
    SINCE,
    TODO,
    FILE,
];

/**
 * Tags whose description is printed verbatim instead of being reflowed as Markdown.
 */
export const TAGS_PRE_FORMATTED_DESCRIPTION: readonly string[] = [
    BORROWS,
    ...TAGS_DEFAULT,
    IMPORT,
    MEMBEROF,
    MODULE,
    SEE,
];

/**
 * Tags dropped entirely when their description is empty.
 */
export const TAGS_DESCRIPTION_NEEDED: readonly string[] = [
    BORROWS,
    CATEGORY,
    DESCRIPTION,
    EXAMPLE,
    IMPORT,
    PRIVATE_REMARKS,
    REMARKS,
    SINCE,
    TODO,
];

export const TAGS_GROUP_HEAD: readonly string[] = [CALLBACK, TYPEDEF];

export const TAGS_GROUP_CONDITION: readonly string[] = [
    ...TAGS_GROUP_HEAD,
    TYPE,
    PROPERTY,
    PARAM,
    RETURNS,
    THIS,
    YIELDS,
    THROWS,
];

export const TAGS_ORDER: Readonly<Record<string, number>> = {
    [IMPORT]: 0,
    [REMARKS]: 1,
    [PRIVATE_REMARKS]: 2,
    [PROVIDES_MODULE]: 3,
    [MODULE]: 4,
    [LICENSE]: 5,
    [FLOW]: 6,
    [ASYNC]: 7,
    [PRIVATE]: 8,
    [IGNORE]: 9,
    [MEMBEROF]: 10,
    [VERSION]: 11,
    [FILE]: 12,
    [AUTHOR]: 13,
    [DEPRECATED]: 14,
    [SINCE]: 15,
    [CATEGORY]: 16,
    [DESCRIPTION]: 17,
    [EXAMPLE]: 18,
    [ABSTRACT]: 19,
    [AUGMENTS]: 20,
    [CONSTANT]: 21,
    [DEFAULT]: 22,
    [DEFAULT_VALUE]: 23,
    [EXTERNAL]: 24,
    [OVERLOAD]: 25,
    [FIRES]: 26,
    [TEMPLATE]: 27,
    [TYPE_PARAM]: 28,
    [FUNCTION]: 29,
    [NAMESPACE]: 30,
    [BORROWS]: 31,
    [CLASS]: 32,
    [EXTENDS]: 33,
    [MEMBER]: 34,
    [TYPEDEF]: 35,
    [TYPE]: 36,
    [SATISFIES]: 37,
    [PROPERTY]: 38,
    [CALLBACK]: 39,
    [THIS]: 39.5,
    [PARAM]: 40,
    [YIELDS]: 41,
    [RETURNS]: 42,
    [THROWS]: 43,
    other: 44,
    [SEE]: 45,
    [TODO]: 46,
};
