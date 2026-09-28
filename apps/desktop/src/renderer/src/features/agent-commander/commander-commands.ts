import type { AgentProvider } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast, tryCommand } from '../../stores/toasts';
import { configureTerminalPaneHost } from '../terminal/terminal-pane-host';

/**
 * Hands a board row to the Workbench window: Main selects the Session there and raises that window. The Commander
 * window never selects a Session itself; it has no Workbench selection to change.
 */
export function revealCommanderSession(sessionId: string): void {
    // Fire-and-forget: tryCommand reports a failed hand-off through a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to show this Session in the Workbench', () =>
        caxri.request('agentCommander.revealSession', { sessionId }),
    );
}

/**
 * Main raises the Workbench, reopening it if needed, and opens Settings there: this window has no Settings of its own.
 * `provider` scrolls Settings straight to that Agent's Executable row when the pane knows which Agent CLI is missing.
 */
export function openWorkbenchSettings(provider?: AgentProvider): void {
    // Fire-and-forget: tryCommand reports a failed hand-off through a toast. Omit the params entirely for the
    // untargeted case, matching every other zero-argument Commander request (e.g. `agentCommander.stop` below),
    // rather than always sending an empty `{}` body.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to open Settings in the Workbench', () =>
        provider
            ? caxri.request('agentCommander.openSettings', {
                  target: { kind: 'agentExecutable', provider },
              })
            : caxri.request('agentCommander.openSettings'),
    );
}

/**
 * The Commander Terminal pane runs in a window without Settings, an editor, or a Git view: Open Settings hands off to
 * the Workbench, and so does opening a detected file link (see `openFileLink` in `terminal-pane-support.ts`, which
 * calls `agentCommander.openFileLink` instead of the ordinary `terminal.openFileLink` whenever this host is installed).
 * Only URLs and files are links here; a commit link has nowhere in this window to open.
 */
export function configureCommanderTerminalHost(): void {
    configureTerminalPaneHost({ openSettings: openWorkbenchSettings, hasWorkbenchLinks: false });
}

/**
 * Main closes this window, then stops the Commander on the Server; a failure surfaces here before the window goes.
 */
export function stopCommander(): void {
    // Fire-and-forget: tryCommand reports a failed stop through a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to stop Agent Commander', () => caxri.request('agentCommander.stop'));
}

export function openCommanderPullRequest(url: string): void {
    // Fire-and-forget: openExternalUrl reports its own rejection through the callback.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void openExternalUrl(url, (message) => pushToast('error', message));
}
