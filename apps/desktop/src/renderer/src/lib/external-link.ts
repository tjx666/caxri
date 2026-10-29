import { translate } from '../i18n';
import { describeFailureKey } from '../stores/toasts';
import { caxri } from './caxri';

type ExternalOpenRejectionReason =
    'credentials_not_allowed' | 'invalid_url' | 'unsupported_protocol';

/**
 * Maps an `external.open` rejection reason to a user-facing sentence. Exported separately from {@link openExternalUrl}
 * so the reason -> message mapping is testable as pure logic below the desktop boundary.
 */
export function externalOpenRejectionMessage(reason: ExternalOpenRejectionReason): string {
    if (reason === 'unsupported_protocol')
        return translate('core.externalLink.unsupportedProtocol');
    if (reason === 'credentials_not_allowed')
        return translate('core.externalLink.credentialsNotAllowed');
    return translate('core.externalLink.invalid');
}

/**
 * Single Renderer entry point for opening a URL outside the app. Main denies every `window.open`/`target="_blank"`
 * navigation (`setWindowOpenHandler` in `apps/desktop/src/main/index.ts`), so a raw anchor never actually navigates:
 * every external link must route through the `external.open` IPC method instead, which re-checks the URL and prompts
 * for untrusted domains.
 */
export async function openExternalUrl(
    url: string,
    onError: (message: string) => void,
): Promise<void> {
    try {
        const result = await caxri.request('external.open', { url });
        if (result.status !== 'rejected') return;
        onError(externalOpenRejectionMessage(result.reason));
    } catch (error) {
        onError(describeFailureKey(error, 'core.externalLink.openFailed', translate));
    }
}
