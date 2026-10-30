import type { Principal, ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { isMobileSubscriptionEvent } from '../subscription-authority';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

describe('isMobileSubscriptionEvent for the dashboard', () => {
    const forward = (event: string) =>
        isMobileSubscriptionEvent({} as ServerDomainService, principal, { kind: 'dashboard' }, {
            event,
            payload: {},
        } as unknown as ServerEvent);

    it('redraws the Session list on state and pull request changes only', async () => {
        await expect(forward('state.changed')).resolves.toBe(true);
        await expect(forward('sessionPullRequests.changed')).resolves.toBe(true);
        await expect(forward('botInbox.changed')).resolves.toBe(false);
    });
});

describe('isMobileSubscriptionEvent for extension views', () => {
    const forward = (sessionId: string, event: string = 'viewContainers.treeChanged') =>
        isMobileSubscriptionEvent(
            {} as ServerDomainService,
            principal,
            { kind: 'extensionViews', sessionId: 'session-1' },
            {
                event,
                payload: { context: { kind: 'session', sessionId } },
            } as unknown as ServerEvent,
        );

    it('forwards tree refreshes scoped to the followed Session only', async () => {
        await expect(forward('session-1')).resolves.toBe(true);
        await expect(forward('session-2')).resolves.toBe(false);
        await expect(forward('session-1', 'git.changed')).resolves.toBe(false);
    });
});
