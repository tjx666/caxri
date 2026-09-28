import type { ShellCommandResult } from '@caxri/protocol';

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
                message: `Shell command 'caxri' installed in PATH at ${result.linkPath}.`,
            };
        case 'alreadyInstalled':
            return {
                kind: 'info',
                message: `Shell command 'caxri' is already installed at ${result.linkPath}.`,
            };
        case 'uninstalled':
            return {
                kind: 'success',
                message: `Shell command 'caxri' removed from ${result.linkPath}.`,
            };
        case 'notInstalled':
            return {
                kind: 'info',
                message: `Shell command 'caxri' is not installed at ${result.linkPath}.`,
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
    // eslint-disable-next-line no-void -- floating-promise discard: `tryCommand` reports failures through its own toast
    void run("Unable to install the 'caxri' shell command", () =>
        caxri.request('shellCommand.install'),
    );
}

export function uninstallShellCommand(): void {
    // eslint-disable-next-line no-void -- floating-promise discard: `tryCommand` reports failures through its own toast
    void run("Unable to uninstall the 'caxri' shell command", () =>
        caxri.request('shellCommand.uninstall'),
    );
}
