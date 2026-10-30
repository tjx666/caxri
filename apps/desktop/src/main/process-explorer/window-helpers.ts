import type { AppLocale } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { resolveRendererEntryUrl } from '../renderer-entry';

interface ProcessExplorerRendererUrlOptions {
    currentDirectory: string;
    forceRenderError?: boolean;
    isPackaged: boolean;
    /**
     * Main's resolved `workbench.language` locale. Process Explorer has no Workbench snapshot to read the setting from,
     * so the locale rides on the entry URL as the `caxri-locale` query parameter and the window opens in the same
     * language as the Workbench instead of the system language.
     */
    locale?: AppLocale;
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
    if (options.locale) rendererUrl.searchParams.set('caxri-locale', options.locale);
    return rendererUrl.href;
}

export function assertTrustedProcessExplorerSender(trustedSender: unknown, sender: unknown): void {
    if (trustedSender === undefined || sender !== trustedSender)
        throw new CaxriError('PATH_DENIED', 'Untrusted Process Explorer IPC sender');
}
