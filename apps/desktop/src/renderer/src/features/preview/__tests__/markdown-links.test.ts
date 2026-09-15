import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../stores/toasts', () => ({ pushToast: vi.fn() }));
vi.mock('../../editor/document-commands', () => ({ openFile: vi.fn() }));
vi.mock('../preview-commands', () => ({ openFilePreview: vi.fn() }));

const { previewLinkAction } = await import('../markdown-links');

describe('previewLinkAction', () => {
    it('jumps inside the document for a heading anchor the engine left unclaimed', () => {
        expect(previewLinkAction(undefined, '#getting-started')).toEqual({
            kind: 'anchor',
            target: 'getting-started',
        });
    });

    it('sends an external link through the trusted open path', () => {
        expect(
            previewLinkAction(
                { id: 'link-1', href: 'https://example.com/docs', external: true },
                'https://example.com/docs',
            ),
        ).toEqual({ kind: 'external', url: 'https://example.com/docs' });
    });

    it('opens a link to another previewable document as a preview', () => {
        expect(
            previewLinkAction(
                {
                    id: 'link-2',
                    href: './CONTRIBUTING.md',
                    external: false,
                    path: '/p/CONTRIBUTING.md',
                },
                '#',
            ),
        ).toEqual({ kind: 'preview', path: '/p/CONTRIBUTING.md' });
    });

    it('opens a link to an ordinary file in the editor', () => {
        expect(
            previewLinkAction(
                { id: 'link-3', href: './src/index.ts', external: false, path: '/p/src/index.ts' },
                '#',
            ),
        ).toEqual({ kind: 'open', path: '/p/src/index.ts' });
    });

    it('ignores a link whose target the engine refused to resolve', () => {
        expect(
            previewLinkAction({ id: 'link-4', href: '../../etc/passwd', external: false }, '#'),
        ).toEqual({ kind: 'ignore' });
    });

    it('ignores an unclaimed anchor that is not an in-page target', () => {
        expect(previewLinkAction(undefined, 'mailto:someone@example.com')).toEqual({
            kind: 'ignore',
        });
    });
});
