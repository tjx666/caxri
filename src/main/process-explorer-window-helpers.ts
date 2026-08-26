import { CaxriError } from '@caxri/protocol';

import { resolveRendererEntryUrl } from './renderer-entry';

interface ProcessExplorerRendererUrlOptions {
    currentDirectory: string;
    forceRenderError?: boolean;
    isPackaged: boolean;
    rendererUrl?: string;
}

export function resolveProcessExplorerRendererUrl(
    options: ProcessExplorerRendererUrlOptions,
): string {
    const rendererUrl = new URL(
        resolveRendererEntryUrl({
            currentDirectory: options.currentDirectory,
            isPackaged: options.isPackaged,
            page: 'process-explorer.html',
            rendererUrl: options.rendererUrl,
        }),
    );
    if (options.forceRenderError) rendererUrl.searchParams.set('caxri-test-render-error', '1');
    return rendererUrl.href;
}

export function assertTrustedProcessExplorerSender(trustedSender: unknown, sender: unknown): void {
    if (trustedSender === undefined || sender !== trustedSender)
        throw new CaxriError('PATH_DENIED', 'Untrusted Process Explorer IPC sender');
}
