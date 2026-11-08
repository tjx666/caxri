import type { CaxriMethod } from '@caxri/protocol';

const fastMobileReadMethods: ReadonlySet<CaxriMethod> = new Set([
    'mobile.dashboard',
    'mobile.session.show',
    'mobile.session.archived',
    'mobile.agent.availability',
    'mobile.botInbox.list',
    'mobile.host.status',
    /**
     * Read right after every connection and on each direct-route probe; as a mutation it would hold back the Relay to
     * direct upgrade it serves.
     */
    'mobile.computer.routes',
    'terminal.preview',
]);

export const isFastMobileRead = (method: CaxriMethod): boolean => fastMobileReadMethods.has(method);
