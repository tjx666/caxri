import type { MihomoControllerAccess, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

export function checkEnvironmentNow() {
    return caxri.request('environmentMonitor.checkNow');
}

export function useCurrentEnvironmentIp() {
    return caxri.request('environmentMonitor.useCurrentIp');
}

export function readMihomoNodes(access: MihomoControllerAccess) {
    const arguments_: ParametersArgument<'environmentMonitor.mihomoNodes'> = [access];
    return caxri.request('environmentMonitor.mihomoNodes', ...arguments_);
}
