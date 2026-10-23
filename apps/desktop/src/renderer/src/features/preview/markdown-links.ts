import type { MarkdownLink } from '@caxri/markdown';

import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import { openFile } from '../editor/document-commands';
import { openLinkedExternalDocument } from '../editor/external-editor-documents';
import type { PreviewAssetSource } from './preview-asset-client';
import { openFilePreview } from './preview-commands';
import { canPreviewPath } from './preview-registry';

export type PreviewLinkAction =
    | { kind: 'anchor'; target: string }
    | { kind: 'external'; url: string }
    | { kind: 'ignore' }
    | { kind: 'open'; path: string }
    | { kind: 'preview'; path: string };

/**
 * Decides what a click on one rendered link means.
 *
 * A document must never navigate the Renderer itself, so every link is claimed here and turned into a Workbench action:
 * an in-page jump, an external open through the trusted `external.open` path, or a tab. A link whose target left the
 * Project root resolved to no path in the engine and is ignored rather than guessed at.
 *
 * A link to another previewable document opens as a preview, matching VS Code: following a README into `docs/` should
 * stay in the reading view rather than dropping into Markdown source.
 */
export function previewLinkAction(link: MarkdownLink | undefined, href: string): PreviewLinkAction {
    if (!link)
        return href.startsWith('#')
            ? { kind: 'anchor', target: href.slice(1) }
            : { kind: 'ignore' };
    if (link.external) return { kind: 'external', url: link.href };
    if (!link.path) return { kind: 'ignore' };
    return canPreviewPath(link.path)
        ? { kind: 'preview', path: link.path }
        : { kind: 'open', path: link.path };
}

function scrollToAnchor(container: HTMLElement, target: string): void {
    const decoded = (() => {
        try {
            return decodeURIComponent(target);
        } catch {
            return target;
        }
    })();
    if (!decoded) return;
    const heading = container.querySelector(`#${CSS.escape(decoded)}`);
    heading?.scrollIntoView({ block: 'start' });
}

function runLinkAction(
    container: HTMLElement,
    action: PreviewLinkAction,
    source: PreviewAssetSource,
): void {
    /**
     * A file an external document links to is outside every Project too, so Main opens it as another external document
     * under the folder grant the linking document already holds.
     */
    if ((action.kind === 'open' || action.kind === 'preview') && 'externalDocumentId' in source) {
        void openLinkedExternalDocument(source, action.path, action.kind === 'preview');
        return;
    }
    switch (action.kind) {
        case 'anchor': {
            scrollToAnchor(container, action.target);
            return;
        }
        case 'external': {
            // Fire-and-forget: `openExternalUrl` reports its own failure through the shared toast.
            void openExternalUrl(action.url, (message) => pushToast('error', message));
            return;
        }
        case 'open': {
            // Fire-and-forget: `openFile` funnels its failures into a toast.
            void openFile(action.path);
            return;
        }
        case 'preview': {
            openFilePreview(action.path);
            return;
        }
        case 'ignore': {
            return;
        }
    }
}

/**
 * Claims every click inside the preview body. The listener lives on the container rather than on each anchor so one
 * registration survives a full re-render of the document.
 */
export function createPreviewLinkHandler(
    container: HTMLElement,
    links: () => readonly MarkdownLink[],
    source: () => PreviewAssetSource,
): (event: MouseEvent) => void {
    return (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest('a');
        if (!anchor) return;
        event.preventDefault();
        const id = anchor.dataset.caxriLink;
        const link = id ? links().find((candidate) => candidate.id === id) : undefined;
        runLinkAction(
            container,
            previewLinkAction(link, anchor.getAttribute('href') ?? ''),
            source(),
        );
    };
}
