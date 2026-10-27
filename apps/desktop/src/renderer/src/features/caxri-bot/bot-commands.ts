import type { AgentProvider } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast, tryCommand } from '../../stores/toasts';
import { confirmBeforeEndingTurn } from '../terminal/agent-turn-guard';
import { configureTerminalPaneHost } from '../terminal/terminal-pane-host';
import { useCaxriBotStore } from './bot-client';

/**
 * Hands a board row to the Workbench window: Main selects the Session there and raises that window. Caxri Bot window
 * never selects a Session itself; it has no Workbench selection to change.
 */
export function revealBotSession(sessionId: string): void {
    // Fire-and-forget: tryCommand reports a failed hand-off through a toast.
    void tryCommand(translate('caxriBot.commands.revealFailed'), () =>
        caxri.request('caxriBot.revealSession', { sessionId }),
    );
}

/**
 * The status bar's `N need you` chip: Main opens or raises the Caxri Bot window and has it open its Inbox and focus the
 * first open item (`caxriBot.open` with `target: 'inbox'`), so the items the chip counts are on screen even when the
 * Inbox was hidden or is a drawer in a narrow window.
 */
export function openBotInbox(): void {
    // Fire-and-forget: tryCommand reports a failed open through a toast.
    void tryCommand(translate('core.commands.openCaxriBotFailed'), () =>
        caxri.request('caxriBot.open', { target: 'inbox' }),
    );
}

/**
 * Main raises the Workbench, reopening it if needed, and opens Settings there: this window has no Settings of its own.
 * `provider` scrolls Settings straight to that Agent's Executable row when the pane knows which Agent CLI is missing.
 */
export function openWorkbenchSettings(provider?: AgentProvider): void {
    // Fire-and-forget: tryCommand reports a failed hand-off through a toast. Omit the params entirely for the
    // untargeted case, matching every other zero-argument Caxri Bot request (e.g. `caxriBot.stop` below),
    // rather than always sending an empty `{}` body.
    void tryCommand(translate('caxriBot.commands.openSettingsFailed'), () =>
        provider
            ? caxri.request('caxriBot.openSettings', {
                  target: { kind: 'agentExecutable', provider },
              })
            : caxri.request('caxriBot.openSettings'),
    );
}

/**
 * Caxri Bot's Terminal pane runs in a window without Settings, an editor, or a Git view: Open Settings hands off to the
 * Workbench, and so does opening a detected file link (see `openFileLink` in `terminal-pane-support.ts`, which calls
 * `caxriBot.openFileLink` instead of the ordinary `terminal.openFileLink` whenever this host is installed). Only URLs
 * and files are links here; a commit link has nowhere in this window to open.
 */
export function configureBotTerminalHost(): void {
    configureTerminalPaneHost({ openSettings: openWorkbenchSettings, hasWorkbenchLinks: false });
}

/**
 * Main closes this window, then stops Caxri Bot on the Server; a failure surfaces here before the window goes. Stopping
 * ends Caxri Bot's Agent Run, so a running turn asks first through the same question as Restart Agent.
 */
export function stopBot(): void {
    const failureTitle = translate('caxriBot.commands.stopFailed');
    const stop = (): void => {
        // Fire-and-forget: tryCommand reports a failed stop through a toast.
        void tryCommand(failureTitle, () => caxri.request('caxriBot.stop'));
    };
    const terminalId = useCaxriBotStore.getState().identity?.terminalId;
    if (!terminalId) {
        stop();
        return;
    }
    void confirmBeforeEndingTurn(
        terminalId,
        {
            confirmLabel: translate('caxriBot.commands.stopAndClose'),
            failureTitle,
            outcome: translate('caxriBot.commands.stopOutcome'),
        },
        stop,
    );
}

export function openBotPullRequest(url: string): void {
    // Fire-and-forget: openExternalUrl reports its own rejection through the callback.
    void openExternalUrl(url, (message) => pushToast('error', message));
}
