import { caxri } from '../../lib/caxri';
import { pushToast } from '../../stores/toasts';
import type { Osc52BlockReason } from './terminal-osc52-clipboard';
import type { TerminalRendererReason } from './terminal-renderer';
import type { TerminalSearchResults } from './terminal-search';

/**
 * Shared, non-hook support used by `useTerminalPaneRuntime`: user-facing copy, small pure helpers, and the one Runtime
 * call whose failure is intentionally unobserved. Kept in its own module so the hook file stays under the repository's
 * per-file line budget.
 */
export const onError = (message: string): void => pushToast('error', message);

/**
 * A blocked OSC 52 write is expected policy enforcement, not a failure — it uses `info` (which auto-dismisses) rather
 * than the persistent `error` styling reserved for `onWriteFailure` below.
 */
export const OSC52_BLOCK_MESSAGES: Record<Osc52BlockReason, string> = {
    'disabled':
        'A Terminal program tried to copy to the clipboard, but OSC 52 access is off in Settings.',
    'malformed': 'A Terminal program sent a malformed clipboard request; it was ignored.',
    'oversized': 'A Terminal program tried to copy too much text at once; the request was ignored.',
    'rate-limited':
        'A Terminal program is copying to the clipboard too quickly; extra requests are being ignored.',
};

export const emptySearchResults: TerminalSearchResults = { resultCount: 0, resultIndex: -1 };

/**
 * Only the reasons the user did not choose are worth a toast: `disabled` reflects their own GPU acceleration setting,
 * `active`/`disposed` are healthy or teardown states, so neither needs one.
 */
export const RENDERER_FALLBACK_MESSAGES: Partial<Record<TerminalRendererReason, string>> = {
    'context-loss':
        'GPU acceleration was lost for this Terminal; it fell back to standard rendering.',
    'load-failed':
        'GPU acceleration could not start for this Terminal; it is using standard rendering.',
    'unsupported':
        'This Terminal is using standard rendering because GPU acceleration is unavailable.',
};

/**
 * SearchAddon requires opaque `#RRGGBB`; imported semantic tokens may include an alpha byte.
 */
export function opaqueSearchColor(color: string): string {
    return color.slice(0, 7);
}

/**
 * A Runtime restart can race a pane teardown, leaving no live view to notify; the failure is intentionally unobserved
 * instead of surfaced through `onError`.
 */
export async function detachTerminalQuietly(terminalId: string): Promise<void> {
    try {
        await caxri.request('terminal.detach', { terminalId });
    } catch {
        // Intentionally swallowed, see the function comment above.
    }
}
