import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Server calls the Mobile Access section makes. Keeping them here rather than inline in the controller hook is the
 * boundary `caxri/server-reads-through-query` enforces: a request written inside a component or hook resolves into
 * state that dies with it, and the next feature copies whatever shape it sees.
 */
export function mobileAccessStatus(): Promise<MethodResult<'mobile.access.status'>> {
    return caxri.request('mobile.access.status');
}

export function setMobileAccessEnabled(
    isEnabled: boolean,
): Promise<MethodResult<'mobile.access.status'>> {
    return caxri.request(isEnabled ? 'mobile.access.enable' : 'mobile.access.disable');
}

export function listMobileDevices(): Promise<MethodResult<'mobile.device.list'>> {
    return caxri.request('mobile.device.list');
}

export function revokeMobileDevice(
    ...arguments_: ParametersArgument<'mobile.device.revoke'>
): Promise<MethodResult<'mobile.device.revoke'>> {
    return caxri.request('mobile.device.revoke', ...arguments_);
}

export function createMobilePairing(
    ...arguments_: ParametersArgument<'mobile.pairing.create'>
): Promise<MethodResult<'mobile.pairing.create'>> {
    return caxri.request('mobile.pairing.create', ...arguments_);
}

export function listMobileGrantableProjects(): Promise<MethodResult<'project.query'>> {
    return caxri.request('project.query', { mode: 'list' });
}
