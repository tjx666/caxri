import type { CaxriMethod } from '@caxri/protocol';

const fastMobileReadMethods: ReadonlySet<CaxriMethod> = new Set([
    'mobile.dashboard',
    'mobile.session.show',
    'mobile.agent.availability',
    'terminal.preview',
]);

export const isFastMobileRead = (method: CaxriMethod): boolean => fastMobileReadMethods.has(method);
