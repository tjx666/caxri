import type { CaxriMethod } from '@caxri/protocol';

const fastMobileReadMethods: ReadonlySet<CaxriMethod> = new Set([
    'mobile.dashboard',
    'mobile.session.show',
    'mobile.session.archived',
    'mobile.agent.availability',
    'mobile.botInbox.list',
    'mobile.host.status',
    'terminal.preview',
]);

export const isFastMobileRead = (method: CaxriMethod): boolean => fastMobileReadMethods.has(method);
