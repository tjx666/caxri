import { translate } from '../i18n';
import { describeFailure, isCancelledRequest } from '../stores/toasts';

/**
 * The failed read opens with `core.documentRead.failed`; `describeFailure` appends the concrete cause behind it (the
 * file is gone, permission was denied, and so on), which is the part that tells the user whether retrying can help.
 *
 * A cancelled read is not a failure the user can act on: Main refuses queued Renderer work once quit starts, and the
 * Host client cancels everything in flight when a lease is replaced, so it is never dressed up as one
 * (`isCancelledRequest` documents the same rule for toasts). It still may not leave the spinner running forever,
 * because nothing re-issues the read afterwards, so it gets a neutral state that offers the retry.
 */
export function describeDocumentReadFailure(error: unknown): {
    reason: string;
    tone: 'failed' | 'interrupted';
} {
    return isCancelledRequest(error)
        ? { reason: translate('core.documentRead.interrupted'), tone: 'interrupted' }
        : {
              reason: describeFailure(error, translate('core.documentRead.failed')),
              tone: 'failed',
          };
}
