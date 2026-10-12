import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import type { TerminalRendererConfirmAction } from './terminal-renderer-status';
import { getTerminalRendererRetry } from './terminal-renderer-status';

/**
 * Asks before the status-bar renderer chip changes a preference or retries the GPU. The chip is a 30px target wedged
 * between unrelated readings. Enabling GPU affects all Terminals; retrying affects this pane and the window's failure
 * budget, so both actions need confirmation before they run.
 *
 * `settings.patch` is the structured single-key write path (the same one the CLI uses), so the change keeps any
 * comments the user hand-wrote in `settings.jsonc` and reaches Terminals through the normal `settings.changed` event:
 * no restart, no separate renderer command.
 */
export async function confirmTerminalRendererSwitch(
    action: TerminalRendererConfirmAction,
    terminalId?: string,
): Promise<void> {
    const retry = terminalId ? getTerminalRendererRetry(terminalId) : undefined;
    const isConfirmed = await caxri.window.showConfirm({
        confirmLabel: action.confirmLabel,
        message: action.message,
        title: action.title,
    });
    if (!isConfirmed) return;
    const preference = action.preference;
    if (!preference) {
        await tryCommand(translate('terminal.renderer.restoreFailed'), () => {
            // The confirmation may outlive its pane. Never apply an old action to a replacement mount.
            if (!terminalId || !retry || getTerminalRendererRetry(terminalId) !== retry)
                return Promise.resolve();
            if (!retry()) throw new Error(translate('terminal.renderer.unavailable'));
            return Promise.resolve();
        });
        return;
    }
    await tryCommand(translate('terminal.renderer.changeFailed'), () =>
        caxri.request('settings.patch', {
            changes: [{ key: 'terminal.gpuAcceleration', value: preference }],
        }),
    );
}
