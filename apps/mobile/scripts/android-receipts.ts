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

const attribute = (source: string, name: string): string | undefined =>
    new RegExp(`${name}="([^"]*)"`, 'u').exec(source)?.[1];

export const isAndroidCheckId = (value: string): boolean =>
    /^[a-z][a-z0-9_.:-]{2,100}$/u.test(value);

const checkIdFromResource = (resourceId: string): string | undefined => {
    const raw = resourceId.includes(':id/')
        ? resourceId.slice(resourceId.lastIndexOf('/') + 1)
        : resourceId;
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
        const checkId = checkIdFromResource(resourceId);
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
