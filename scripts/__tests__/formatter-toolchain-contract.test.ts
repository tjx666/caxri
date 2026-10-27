import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatSource } from '../format-source';

const root = resolve(import.meta.dirname, '../..');

describe('bun fmt toolchain contract', () => {
    it('keeps the base options identical to the former shared Prettier config', async () => {
        const bunfig = await readFile(resolve(root, 'bunfig.toml'), 'utf8');

        expect(bunfig).toContain('printWidth = 100');
        expect(bunfig).toContain('tabWidth = 4');
        expect(bunfig).toContain('singleQuote = true');
        expect(bunfig).toContain('trailingComma = "all"');
        expect(bunfig).toContain('semi = true');
        expect(bunfig).toContain('quoteProps = "consistent"');
    });

    it('formats with the repository options rather than bun fmt defaults', async () => {
        const formatted = await formatSource(
            'const value = {"a-b": 1, c: "two"}\n',
            resolve(root, 'scripts/fixtures/formatter-options.ts'),
        );

        expect(formatted).toBe("const value = { 'a-b': 1, 'c': 'two' };\n");
    });

    it('sorts unsorted Tailwind classes inside a `cn(...)` call against the Renderer theme stylesheet', async () => {
        // `theme.css` (not `styles.css`) owns the `@theme` / `@theme inline` token definitions the
        // Tailwind sorter needs to recognize the project's custom utilities (`bg-surface`,
        // `text-muted`, ...); see `apps/desktop/src/renderer/src/styles/theme.css`.
        const unsorted = [
            "import { cn } from './lib/utils';",
            '',
            'export function Example() {',
            "    return <div className={cn('text-muted flex items-center bg-surface')} />;",
            '}',
            '',
        ].join('\n');

        const formatted = await formatSource(
            unsorted,
            resolve(root, 'apps/desktop/src/renderer/src/__fixtures__/tailwind-sort.tsx'),
        );

        expect(formatted).toContain("cn('flex items-center bg-surface text-muted')");
    });

    it('indents YAML and Markdown with two spaces', async () => {
        const formatted = await formatSource('a:\n    b: 1\n', resolve(root, 'fixture.yaml'));

        expect(formatted).toBe('a:\n  b: 1\n');
    });
});
