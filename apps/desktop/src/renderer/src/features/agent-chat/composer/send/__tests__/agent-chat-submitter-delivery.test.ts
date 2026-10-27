import { describe, expect, it } from 'vitest';

import { agentChatSubmitterDelivery } from '../agent-chat-submitter-delivery';

/**
 * A form submitter as the composer sees it: the Send button carries `value`; another submitter may not.
 */
function submitter(value?: string): HTMLElement {
    return (value === undefined ? {} : { value }) as HTMLElement;
}

describe('agentChatSubmitterDelivery', () => {
    it('steers or queues only from a Send button whose delivery value says so', () => {
        expect(agentChatSubmitterDelivery(submitter('steer'))).toBe('steer');
        expect(agentChatSubmitterDelivery(submitter('queue'))).toBe('queue');
        expect(agentChatSubmitterDelivery(submitter('send'))).toBeUndefined();
        expect(agentChatSubmitterDelivery(submitter(''))).toBeUndefined();
        expect(agentChatSubmitterDelivery(submitter())).toBeUndefined();
        expect(agentChatSubmitterDelivery(null)).toBeUndefined();
    });
});
