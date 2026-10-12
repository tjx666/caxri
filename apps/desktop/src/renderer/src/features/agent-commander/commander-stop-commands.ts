import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Stops the Commander from the Workbench (command palette or native menu). The Workbench cannot see the Commander's
 * Terminal, so it reads the content-free `commander.status`: a `working` Commander asks the same question as the
 * Commander window's own Stop button before its turn ends.
 */
export async function stopCommanderFromWorkbench(): Promise<void> {
    const failureTitle = translate('agentCommander.commands.stopFailed');
    const status = await tryCommand(failureTitle, () => caxri.request('commander.status', {}));
    if (status === undefined) return;
    if (status.state === 'working') {
        const isConfirmed = await tryCommand(failureTitle, () =>
            caxri.window.showConfirm({
                title: translate('agentCommander.commands.stopTurnTitle'),
                message: translate('agentCommander.commands.stopTurnMessage'),
                confirmLabel: translate('agentCommander.commands.stopAndClose'),
            }),
        );
        if (isConfirmed !== true) return;
    }
    await tryCommand(failureTitle, () => caxri.request('agentCommander.stop'));
}
