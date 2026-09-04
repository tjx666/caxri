import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import type { TerminalRendererIndicatorAction } from './terminal-renderer-status';

/**
 * Asks before the status-bar renderer chip changes a persisted preference. The chip is a 30px target wedged between
 * unrelated readings, and confirming re-renders every open Terminal, so an accidental click has to be recoverable
 * before the write lands rather than after it.
 *
 * `settings.patch` is the structured single-key write path (the same one the CLI uses), so the change keeps any
 * comments the user hand-wrote in `settings.jsonc` and reaches Terminals through the normal `settings.changed` event —
 * no restart, no separate renderer command.
 */
export async function confirmTerminalRendererSwitch(
    action: TerminalRendererIndicatorAction,
): Promise<void> {
    const isConfirmed = await caxri.window.showConfirm({
        confirmLabel: action.confirmLabel,
        message: action.message,
        title: action.title,
    });
    if (!isConfirmed) return;
    await tryCommand('Unable to change GPU acceleration', () =>
        caxri.request('settings.patch', {
            changes: [{ key: 'terminal.gpuAcceleration', value: action.preference }],
        }),
    );
}
