import { resolve } from 'node:path';

import prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import prettierConfig from '../../prettier.config.ts';

const root = resolve(import.meta.dirname, '../..');

describe('shared Prettier config toolchain contract', () => {
    it('keeps the base options identical to the repository`s pre-migration `.prettierrc`', () => {
        expect(prettierConfig.printWidth).toBe(100);
        expect(prettierConfig.tabWidth).toBe(4);
        expect(prettierConfig.singleQuote).toBe(true);
        expect(prettierConfig.trailingComma).toBe('all');
        expect(prettierConfig.semi).toBe(true);
        expect(prettierConfig.quoteProps).toBe('consistent');
        expect(prettierConfig.endOfLine).toBe('auto');
    });

    it('appends `prettier-plugin-tailwindcss` last, after the shared xml/jsdoc plugins', () => {
        const plugins = prettierConfig.plugins as string[];

        expect(plugins.length).toBeGreaterThanOrEqual(3);
        expect(plugins.some((plugin) => plugin.includes('@prettier/plugin-xml'))).toBe(true);
        expect(plugins.some((plugin) => plugin.includes('prettier-plugin-jsdoc'))).toBe(true);

        const lastPlugin = plugins.at(-1);
        expect(lastPlugin).toContain('prettier-plugin-tailwindcss');
    });

    it('wires `cn`/`cva` as Tailwind sort functions against the Renderer`s verified theme stylesheet', () => {
        expect(prettierConfig.tailwindFunctions).toContain('cn');
        expect(prettierConfig.tailwindFunctions).toContain('cva');
        // `theme.css` (not `styles.css`) owns the `@theme` / `@theme inline` token definitions that
        // `prettier-plugin-tailwindcss` needs to recognize the project's custom utilities
        // (`bg-surface`, `text-muted`, ...); see `src/renderer/src/styles/theme.css`.
        expect(prettierConfig.tailwindStylesheet).toBe('./src/renderer/src/styles/theme.css');
    });

    it('actually sorts unsorted Tailwind classes inside a `cn(...)` call (proves the plugin is live)', async () => {
        const unsorted = [
            "import { cn } from './lib/utils';",
            '',
            'export function Example() {',
            "    return <div className={cn('text-muted flex items-center bg-surface')} />;",
            '}',
            '',
        ].join('\n');

        const formatted = await prettier.format(unsorted, {
            ...prettierConfig,
            cwd: root,
            filepath: resolve(root, 'src/renderer/src/__fixtures__/prettier-tailwind-sort.tsx'),
        });

        expect(formatted).toContain("cn('flex items-center bg-surface text-muted')");
        expect(formatted).not.toContain("cn('text-muted flex items-center bg-surface')");
    });
});
