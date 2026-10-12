import type { TerminalResourceAlert } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { translate } from '../../i18n';
import { formatCpuPercent, formatMemoryMb } from '../../lib/resource-usage-format';
import { dismissToastsMatching, pushToast } from '../../stores/toasts';

/**
 * The live alert message per Terminal, so a `cleared` event or a Stop can retract exactly the toast it raised. The
 * message embeds readings that change between episodes, so it cannot be rebuilt from the Terminal alone.
 */
const liveAlerts = new Map<string, string>();

function alertSubject(terminal: TerminalResourceAlert['terminal']): string {
    const name = terminal.provider
        ? agentProviderCatalog[terminal.provider].displayName
        : terminal.title || translate('terminal.defaultTitle');
    return terminal.sessionTitle ? `${name} · ${terminal.sessionTitle}` : name;
}

/**
 * Formats a raised alert. Both readings are shown so the reader can tell a memory leak from a CPU spin at a glance.
 */
export function terminalResourceAlertMessage(alert: TerminalResourceAlert): string {
    const memory = formatMemoryMb(alert.memoryMb);
    const cpu = formatCpuPercent(alert.cpuPercent);
    return translate('terminal.resourceAlert.message', {
        cpu,
        memory,
        subject: alertSubject(alert.terminal),
    });
}

export function dismissTerminalResourceAlert(terminalId: string): void {
    const message = liveAlerts.get(terminalId);
    liveAlerts.delete(terminalId);
    if (message) dismissToastsMatching((title) => title === message);
}

/**
 * Shows a raised alert until the user dismisses it or the Server reports the episode over. The notice persists because
 * a runaway process keeps costing the machine until someone acts; a four-second toast would let it slip by unnoticed
 * while the user is in another app.
 */
export function reportTerminalResourceAlert(alert: TerminalResourceAlert): void {
    const { terminalId } = alert.terminal;
    if (alert.state === 'cleared') {
        dismissTerminalResourceAlert(terminalId);
        return;
    }
    dismissTerminalResourceAlert(terminalId);
    const message = terminalResourceAlertMessage(alert);
    liveAlerts.set(terminalId, message);
    pushToast('warning', message, {
        persist: true,
        secondaryAction: { id: 'processExplorer.open' },
        action: {
            id: 'terminal.stopRunaway',
            params: { terminalId, processId: alert.terminal.processId },
            accessibleLabel: translate('terminal.resourceAlert.stop', {
                subject: alertSubject(alert.terminal),
            }),
        },
    });
}
