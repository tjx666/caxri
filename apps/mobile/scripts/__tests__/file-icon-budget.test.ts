import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { FILE_ICON_SVGS } from '../../src/features/panels/file-icons.generated';
import {
    compressIconSvg,
    resolveIconSvgSource,
    restoreLeadingZeros,
    selectIconsWithinBudget,
} from '../file-icon-budget';

describe('compressIconSvg', () => {
    it('drops comments and doctype boilerplate and shrinks needless coordinate precision', () => {
        const verbose = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">
<!-- generator: some tool -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M1.123456 2.987654 L10.000001 10.000001 L20 20Z" fill="#ff0000"/>
</svg>`;
        const compressed = compressIconSvg(verbose, 'file_type_example.svg');

        expect(compressed).not.toContain('<!--');
        expect(compressed).not.toContain('<!DOCTYPE');
        expect(compressed).not.toContain('<?xml');
        expect(Buffer.byteLength(compressed)).toBeLessThan(Buffer.byteLength(verbose));
        // Precision drops to one decimal place instead of the source's six.
        expect(compressed).not.toMatch(/\d\.\d{2,}/u);
    });

    it('namespaces internal ids so two compressed icons never collide when concatenated', () => {
        const withGradient = (
            id: string,
        ) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="${id}"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
  <rect width="32" height="32" fill="url(#${id})"/>
</svg>`;
        // Both source icons happen to reuse the same short, generic gradient id, as upstream vscode-icons commonly does.
        const first = compressIconSvg(withGradient('a'), 'file_type_one.svg');
        const second = compressIconSvg(withGradient('a'), 'file_type_two.svg');

        const idOf = (svg: string): string | undefined => /id="([^"]+)"/u.exec(svg)?.[1];
        expect(idOf(first)).toBeDefined();
        expect(idOf(first)).not.toBe(idOf(second));
        // Concatenating both into one document must not let the second icon's fill resolve to the first's gradient.
        expect(first).toContain(`url(#${idOf(first)})`);
        expect(second).toContain(`url(#${idOf(second)})`);
    });

    it('is deterministic for the same file name and content', () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
        expect(compressIconSvg(svg, 'file_type_example.svg')).toBe(
            compressIconSvg(svg, 'file_type_example.svg'),
        );
    });
});

describe('selectIconsWithinBudget', () => {
    const readBytes = (sizes: Record<string, number>) => (icon: string) =>
        Promise.resolve(sizes[icon] ?? 0);

    it('keeps icons at or under the budget and drops ones over it', async () => {
        const result = await selectIconsWithinBudget(
            [
                ['ts', 'file_type_typescript.svg'],
                ['pdf', 'file_type_pdf.svg'],
            ],
            'file_type_default.svg',
            8192,
            readBytes({ 'file_type_pdf.svg': 40_000, 'file_type_typescript.svg': 500 }),
        );

        expect(result.kept).toEqual([['ts', 'file_type_typescript.svg']]);
        expect(result.oversize).toEqual([
            { bytes: 40_000, icon: 'file_type_pdf.svg', name: 'pdf' },
        ]);
    });

    it('drops entries that resolve to the fallback icon without measuring them', async () => {
        let measured = 0;
        const result = await selectIconsWithinBudget(
            [['unknownext', 'file_type_default.svg']],
            'file_type_default.svg',
            8192,
            () => {
                measured += 1;
                return Promise.resolve(100);
            },
        );

        expect(result.kept).toEqual([]);
        expect(result.oversize).toEqual([]);
        expect(measured).toBe(0);
    });

    it('drops entries with no resolved icon', async () => {
        const result = await selectIconsWithinBudget(
            [['noicon', undefined]],
            'file_type_default.svg',
            8192,
            readBytes({}),
        );

        expect(result.kept).toEqual([]);
        expect(result.oversize).toEqual([]);
    });

    it('records every name that maps to the same oversize icon', async () => {
        const result = await selectIconsWithinBudget(
            [
                ['license', 'file_type_license.svg'],
                ['license.md', 'file_type_license.svg'],
            ],
            'file_type_default.svg',
            8192,
            readBytes({ 'file_type_license.svg': 16_000 }),
        );

        expect(result.kept).toEqual([]);
        expect(result.oversize).toEqual([
            { bytes: 16_000, icon: 'file_type_license.svg', name: 'license' },
            { bytes: 16_000, icon: 'file_type_license.svg', name: 'license.md' },
        ]);
    });

    it('keeps an icon exactly at the byte budget', async () => {
        const result = await selectIconsWithinBudget(
            [['edge', 'file_type_edge.svg']],
            'file_type_default.svg',
            8192,
            readBytes({ 'file_type_edge.svg': 8192 }),
        );

        expect(result.kept).toEqual([['edge', 'file_type_edge.svg']]);
        expect(result.oversize).toEqual([]);
    });
});

describe('resolveIconSvgSource', () => {
    const missing = (): Promise<string> => {
        const error = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        return Promise.reject(error);
    };

    it('prefers a hand-simplified override when one exists', async () => {
        const svg = await resolveIconSvgSource(
            'file_type_bundler.svg',
            () => Promise.resolve('<svg>override</svg>'),
            () => Promise.resolve('<svg>vendor</svg>'),
        );

        expect(svg).toBe('<svg>override</svg>');
    });

    it('falls back to the vendored icon when no override file exists', async () => {
        const svg = await resolveIconSvgSource('file_type_typescript.svg', missing, () =>
            Promise.resolve('<svg>vendor</svg>'),
        );

        expect(svg).toBe('<svg>vendor</svg>');
    });

    it('does not mask a real read failure as a missing override', async () => {
        const permissionDenied = (): Promise<string> => {
            const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            return Promise.reject(error);
        };

        await expect(
            resolveIconSvgSource('file_type_bundler.svg', permissionDenied, () =>
                Promise.resolve('<svg>vendor</svg>'),
            ),
        ).rejects.toThrow('EACCES');
    });
});

describe('restoreLeadingZeros', () => {
    it('adds the leading zero react-native-svg needs to bare fraction attributes and style values', () => {
        const svg =
            '<svg><linearGradient><stop offset=".5" stop-opacity=\'.7\'/><stop offset="-.25%"/></linearGradient>' +
            '<path d="M.5.5L1 .5" opacity=".3" style="fill:#fff;stroke-width:.75px"/></svg>';

        expect(restoreLeadingZeros(svg)).toBe(
            '<svg><linearGradient><stop offset="0.5" stop-opacity=\'0.7\'/><stop offset="-0.25%"/></linearGradient>' +
                '<path d="M.5.5L1 .5" opacity="0.3" style="fill:#fff;stroke-width:0.75px"/></svg>',
        );
    });

    it('leaves values that already carry a leading zero or are not a single number unchanged', () => {
        const svg =
            '<svg viewBox=".5 0 32 32"><stop offset="0.5"/><stop offset="1"/><path id="a.5"/></svg>';

        expect(restoreLeadingZeros(svg)).toBe(svg);
    });
});

describe('generated file icons', () => {
    it('never ships a numeric attribute or style value without its leading zero', () => {
        const offenders = Object.entries(FILE_ICON_SVGS)
            .filter(([, svg]) => /(?:="|:)-?\.\d/u.test(svg))
            .map(([icon]) => icon);

        expect(offenders).toEqual([]);
    });
});
