import { createHash } from 'node:crypto';

import { optimize } from 'svgo';

/**
 * Upstream `@yutengjing/vscode-icons` SVGs vary from under 1 KB to over 40 KB: some embed raster art, others carry
 * high-precision isometric shading with dozens of paths. svgo's default optimizations plus a low float precision
 * recover most of that for free, before any hand-simplified replacement is needed (see `file-icon-overrides/`).
 *
 * `prefixIds` namespaces each icon's internal `<linearGradient>`/`<clipPath>` ids by its file. Upstream reuses short
 * generic ids (`a`, `b`, …) per file, which is safe while every icon renders through its own isolated `SvgXml`
 * instance, but all ~170 compressed icons still land together in one generated module; namespacing removes the risk
 * entirely if a future consumer ever concatenates the raw markup (e.g. a web/WebView render path) instead of mounting
 * one `SvgXml` per icon. A 6-hex-char hash of the file name keeps that safety margin cheap — the plugin's own default
 * prefix (the full file name) pushed at least one already-tight icon back over `MAX_ICON_BYTES`.
 */
export const compressIconSvg = (svg: string, file: string): string =>
    optimize(svg, {
        floatPrecision: 1,
        multipass: true,
        path: file,
        plugins: [
            'preset-default',
            {
                name: 'prefixIds',
                params: {
                    delim: '',
                    prefix: createHash('sha1').update(file).digest('hex').slice(0, 6),
                },
            },
        ],
    }).data;

interface IconBudgetEntry {
    readonly bytes: number;
    readonly icon: string;
    readonly name: string;
}

export interface IconBudgetResult {
    readonly kept: ReadonlyArray<[string, string]>;
    readonly oversize: readonly IconBudgetEntry[];
}

/**
 * Splits curated name → icon-file entries into ones that fit `maxBytes` (after compression) and ones that don't. A name
 * that resolves to `fallback` is dropped entirely: it adds nothing over the runtime default already shown for
 * unresolved names. `readBytes` is injected so callers can back it with disk I/O while tests exercise the pure
 * partitioning behavior with controlled sizes.
 */
export const selectIconsWithinBudget = async (
    entries: ReadonlyArray<[string, string | undefined]>,
    fallback: string,
    maxBytes: number,
    readBytes: (icon: string) => Promise<number>,
): Promise<IconBudgetResult> => {
    const kept: Array<[string, string]> = [];
    const oversize: IconBudgetEntry[] = [];
    await Promise.all(
        entries.map(async ([name, icon]) => {
            if (!icon || icon === fallback) return;
            const bytes = await readBytes(icon);
            if (bytes > maxBytes) oversize.push({ bytes, icon, name });
            else kept.push([name, icon]);
        }),
    );
    return { kept, oversize };
};

/**
 * A curated icon can be hand-simplified under `file-icon-overrides/<file>` when compression alone can't bring it under
 * budget (see the PDF, bundler, and license replacements). The override is preferred when present; any other read
 * failure (not "missing") is a real error and must not be masked by silently falling back to the vendor asset.
 */
export const resolveIconSvgSource = async (
    file: string,
    readOverride: (file: string) => Promise<string>,
    readVendor: (file: string) => Promise<string>,
): Promise<string> => {
    try {
        return await readOverride(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readVendor(file);
        throw error;
    }
};
