import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../render-markdown.js';

const location = { documentPath: '/projects/app/docs/guide.md', projectRoot: '/projects/app' };

function render(source: string) {
    return renderMarkdown(source, location);
}

describe('renderMarkdown', () => {
    it('renders GitHub-flavored blocks the preview promises to support', () => {
        const { html } = render(
            [
                '| a | b |',
                '| - | - |',
                '| 1 | 2 |',
                '',
                '~~gone~~',
                '',
                '- [ ] open',
                '- [x] done',
            ].join('\n'),
        );

        expect(html).toContain('<table');
        expect(html).toContain('<s>gone</s>');
        expect(html).toContain('type="checkbox" disabled>');
        expect(html).toContain('type="checkbox" disabled checked>');
        expect(html).toContain('caxri-markdown-task');
    });

    it('anchors top-level blocks to their source line so the host can follow the editor', () => {
        const { html } = render('# Title\n\nParagraph\n');

        expect(html).toContain('data-line="0"');
        expect(html).toContain('data-line="2"');
    });

    it('gives repeated headings distinct anchors', () => {
        const { html } = render('# Setup\n\n## Setup\n');

        expect(html).toContain('id="setup"');
        expect(html).toContain('id="setup-1"');
    });

    it('keeps fenced code out of the HTML so highlighting and copying use the exact source', () => {
        const { html, codeBlocks } = render('```ts\nconst value = 1 < 2;\n```\n');

        expect(codeBlocks).toEqual([
            { id: 'code-1', language: 'ts', code: 'const value = 1 < 2;\n' },
        ]);
        expect(html).toContain('data-caxri-code="code-1"');
        expect(html).toContain('data-caxri-language="ts"');
        expect(html).toContain('const value = 1 &lt; 2;');
    });

    it('routes mermaid fences to the diagram table instead of a code block', () => {
        const { html, codeBlocks, diagrams } = render('```mermaid\ngraph TD;\nA-->B;\n```\n');

        expect(codeBlocks).toEqual([]);
        expect(diagrams).toEqual([{ id: 'diagram-1', source: 'graph TD;\nA-->B;\n' }]);
        expect(html).toContain('data-caxri-diagram="diagram-1"');
    });

    it('resolves document-relative and root-relative images inside the Project root', () => {
        const { assets } = render('![one](./img/one.png)\n\n![two](/shared/two.png)\n');

        expect(assets).toEqual([
            { id: 'asset-1', source: './img/one.png', path: '/projects/app/docs/img/one.png' },
            { id: 'asset-2', source: '/shared/two.png', path: '/projects/app/shared/two.png' },
        ]);
    });

    it('refuses to resolve an image that escapes the Project root', () => {
        const { assets } = render('![escape](../../etc/passwd.png)\n');

        expect(assets).toEqual([{ id: 'asset-1', source: '../../etc/passwd.png' }]);
    });

    it('keeps remote images addressable and emits no filesystem path into the HTML', () => {
        const { assets, html } = render('![remote](https://example.com/a.png)\n');

        expect(assets).toEqual([
            {
                id: 'asset-1',
                source: 'https://example.com/a.png',
                url: 'https://example.com/a.png',
            },
        ]);
        expect(html).not.toContain('src=');
    });

    it('separates external links from in-Project document links', () => {
        const { html, links } = render(
            '[out](https://example.com) [next](./other.md) [top](#title)\n',
        );

        expect(links).toEqual([
            { id: 'link-1', href: 'https://example.com', external: true },
            {
                id: 'link-2',
                href: './other.md',
                external: false,
                path: '/projects/app/docs/other.md',
            },
        ]);
        // In-page anchors stay ordinary links; only host-routed targets get an id.
        expect(html).toContain('href="#title"');
        expect(html.match(/data-caxri-link=/gu)).toHaveLength(2);
    });

    it('does not carry per-document state between renders', () => {
        render('# Title\n\n![a](./a.png)\n');
        const { assets, html } = render('# Title\n\n![a](./a.png)\n');

        expect(assets[0]?.id).toBe('asset-1');
        expect(html).toContain('id="title"');
        expect(html).not.toContain('id="title-1"');
    });
});
