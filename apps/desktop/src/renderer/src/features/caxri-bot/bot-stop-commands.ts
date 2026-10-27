import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Stops Caxri Bot from the Workbench (command palette or native menu). The Workbench cannot see Caxri Bot's Terminal,
 * so it reads the content-free `bot.status`: a `working` Caxri Bot asks the same question as the The Caxri Bot window's
 * own Stop button before its turn ends.
 */
export async function stopBotFromWorkbench(): Promise<void> {
    const failureTitle = translate('caxriBot.commands.stopFailed');
    const status = await tryCommand(failureTitle, () => caxri.request('bot.status', {}));
    if (status === undefined) return;
    if (status.state === 'working') {
        const isConfirmed = await tryCommand(failureTitle, () =>
            caxri.window.showConfirm({
                title: translate('caxriBot.commands.stopTurnTitle'),
                message: translate('caxriBot.commands.stopTurnMessage'),
                confirmLabel: translate('caxriBot.commands.stopAndClose'),
            }),
        );
        if (isConfirmed !== true) return;
    }
    await tryCommand(failureTitle, () => caxri.request('caxriBot.stop'));
}
