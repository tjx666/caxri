import { describe, expect, it } from 'vitest';

import { MobileWaitTimeoutError, waitForMobile } from './mobile-wait';

describe('Android Acceptance bounded waits', () => {
    it('names the wait and its limit when it times out', async () => {
        const wait = waitForMobile(
            () => ['agent-chat-composer'],
            () => false,
            0,
            'recent video attached as a playable file card',
        );
        await expect(wait).rejects.toBeInstanceOf(MobileWaitTimeoutError);
        await expect(wait).rejects.toThrow(
            'Mobile Acceptance timed out after 0ms waiting for recent video attached as a playable file card',
        );
    });

    it('never puts the observed value in the message', async () => {
        await expect(
            waitForMobile(
                () => ['files-entry-private-name.txt'],
                () => false,
                0,
            ),
        ).rejects.toThrow(/^Mobile Acceptance timed out after 0ms$/u);
    });
});
