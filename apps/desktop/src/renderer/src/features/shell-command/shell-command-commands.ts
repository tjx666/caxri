import type { ShellCommandResult } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * Maps each closed outcome to its confirmation. `canceled` stays silent: the user just dismissed the prompt themselves.
 */
export function shellCommandToast(
    result: ShellCommandResult,
): { kind: 'info' | 'success'; message: string } | undefined {
    switch (result.status) {
        case 'installed':
            return {
                kind: 'success',
                message: translate('shellCommand.installed', { path: result.linkPath }),
            };
        case 'alreadyInstalled':
            return {
                kind: 'info',
                message: translate('shellCommand.alreadyInstalled', { path: result.linkPath }),
            };
        case 'uninstalled':
            return {
                kind: 'success',
                message: translate('shellCommand.uninstalled', { path: result.linkPath }),
            };
        case 'notInstalled':
            return {
                kind: 'info',
                message: translate('shellCommand.notInstalled', { path: result.linkPath }),
            };
        case 'canceled':
            return undefined;
    }
}

async function run(label: string, request: () => Promise<ShellCommandResult>): Promise<void> {
    const result = await tryCommand(label, request);
    const toast = result && shellCommandToast(result);
    if (toast) pushToast(toast.kind, toast.message);
}

export function installShellCommand(): void {
    void run(translate('shellCommand.installFailed'), () => caxri.request('shellCommand.install'));
}

export function uninstallShellCommand(): void {
    void run(translate('shellCommand.uninstallFailed'), () =>
        caxri.request('shellCommand.uninstall'),
    );
}
