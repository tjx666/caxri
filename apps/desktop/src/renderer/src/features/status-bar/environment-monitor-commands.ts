import type { EnvironmentMonitorState } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';

const queryKey = caxriQueryKey('environmentMonitor.read', undefined);

async function run(
    method: 'environmentMonitor.acceptBaseline' | 'environmentMonitor.refresh',
    failureLabel: string,
): Promise<EnvironmentMonitorState | undefined> {
    return tryCommand(failureLabel, async () => {
        const result = await caxri.request(method);
        queryClient.setQueryData(queryKey, result);
        return result;
    });
}

export function refreshEnvironmentMonitor(): Promise<EnvironmentMonitorState | undefined> {
    return run(
        'environmentMonitor.refresh',
        translate('statusBar.environmentMonitor.refreshFailed'),
    );
}

export function acceptEnvironmentMonitorBaseline(): Promise<EnvironmentMonitorState | undefined> {
    return run(
        'environmentMonitor.acceptBaseline',
        translate('statusBar.environmentMonitor.acceptFailed'),
    );
}
