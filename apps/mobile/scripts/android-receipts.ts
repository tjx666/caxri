export interface AndroidSemanticNode {
    bounds: string;
    checkId: string;
    className: string;
    clickable: boolean;
    enabled: boolean;
}

export interface AndroidPoint {
    x: number;
    y: number;
}

export interface AndroidNodeTextExpectation {
    kind: 'equals' | 'includes';
    value: string;
}

export interface AndroidNodeObservation {
    exists: boolean;
    focused: boolean;
    textMatches?: boolean;
}

const attribute = (source: string, name: string): string | undefined =>
    new RegExp(String.raw`\s${name}="([^"]*)"`, 'u').exec(source)?.[1];

const decodeXmlAttribute = (value: string): string =>
    value.replaceAll(/&(?:#(?:x[\da-fA-F]+|\d+)|amp|apos|gt|lt|quot);/gu, (entity) => {
        const reference = entity.slice(1, -1);
        if (reference.startsWith('#')) {
            const isHexadecimal = reference[1]?.toLowerCase() === 'x';
            const codePoint = Number.parseInt(
                reference.slice(isHexadecimal ? 2 : 1),
                isHexadecimal ? 16 : 10,
            );
            return Number.isFinite(codePoint) && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : entity;
        }
        return (
            (
                {
                    amp: '&',
                    apos: "'",
                    gt: '>',
                    lt: '<',
                    quot: '"',
                } as Record<string, string>
            )[reference] ?? entity
        );
    });

export const isAndroidCheckId = (value: string): boolean =>
    /^[a-z][a-z0-9_.:-]{2,100}$/u.test(value);

const checkIdFromResource = (resourceId: string, expectedPackage: string): string | undefined => {
    const separator = resourceId.indexOf(':id/');
    if (separator !== -1 && resourceId.slice(0, separator) !== expectedPackage) return;
    const raw = separator === -1 ? resourceId : resourceId.slice(separator + 4);
    if (!isAndroidCheckId(raw)) return;
    return raw;
};

/**
 * Projects a UIAutomator dump to a content-free receipt. The raw XML is intentionally never returned because it
 * includes visible text and accessibility descriptions.
 */
export const semanticNodesFromUiAutomator = (
    source: string,
    expectedPackage = 'com.caxri.mobile',
): AndroidSemanticNode[] => {
    const nodes = new Map<string, AndroidSemanticNode>();
    for (const match of source.matchAll(/<node\s[^>]*>/gu)) {
        const node = match[0];
        if (attribute(node, 'package') !== expectedPackage) continue;
        const resourceId = attribute(node, 'resource-id');
        if (!resourceId) continue;
        const checkId = checkIdFromResource(resourceId, expectedPackage);
        if (!checkId || nodes.has(checkId)) continue;
        nodes.set(checkId, {
            bounds: attribute(node, 'bounds') ?? '',
            checkId,
            className: attribute(node, 'class') ?? 'unknown',
            clickable: attribute(node, 'clickable') === 'true',
            enabled: attribute(node, 'enabled') === 'true',
        });
    }
    return nodes
        .values()
        .toArray()
        .toSorted((left, right) => left.checkId.localeCompare(right.checkId));
};

/**
 * Evaluates a single Caxri test ID inside the device dump. Only the structural and comparison booleans may leave this
 * boundary; the decoded text and raw XML remain local to this function.
 */
export const observeAndroidNodeFromUiAutomator = (
    source: string,
    checkId: string,
    expectedText?: AndroidNodeTextExpectation,
    expectedPackage = 'com.caxri.mobile',
): AndroidNodeObservation => {
    if (!isAndroidCheckId(checkId)) throw new Error('Android check ID is invalid');

    for (const match of source.matchAll(/<node\s[^>]*>/gu)) {
        const node = match[0];
        if (attribute(node, 'package') !== expectedPackage) continue;
        const resourceId = attribute(node, 'resource-id');
        if (!resourceId || checkIdFromResource(resourceId, expectedPackage) !== checkId) continue;

        const observation: AndroidNodeObservation = {
            exists: true,
            focused: attribute(node, 'focused') === 'true',
        };
        if (expectedText) {
            const text = decodeXmlAttribute(attribute(node, 'text') ?? '');
            observation.textMatches =
                expectedText.kind === 'equals'
                    ? text === expectedText.value
                    : text.includes(expectedText.value);
        }
        return observation;
    }

    return {
        exists: false,
        focused: false,
        ...(expectedText && { textMatches: false }),
    };
};

export const resumedPackageFromWindowDump = (source: string): string | undefined =>
    /(?:mCurrentFocus|mFocusedApp)[^\n]*\s([a-zA-Z][\w.]*)\/[\w.$]+/u.exec(source)?.[1];

export const centerOfAndroidBounds = (source: string): AndroidPoint => {
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(source);
    if (!match) throw new Error('Android bounds are invalid');
    const [left, top, right, bottom] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
    ];
    if (right <= left || bottom <= top) throw new Error('Android bounds are invalid');
    return {
        x: Math.floor((left + right) / 2),
        y: Math.floor((top + bottom) / 2),
    };
};
