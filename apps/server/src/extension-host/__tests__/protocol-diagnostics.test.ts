import { describe, expect, it, vi } from 'vitest';

import { logProtocolRejection } from '../protocol-diagnostics';

describe('Extension Host protocol rejection diagnostics', () => {
    it.each(['parent-envelope', 'child-envelope', 'reply-result'] as const)(
        'records only the closed %s reason',
        (reason) => {
            const write = vi.fn();
            logProtocolRejection({ write }, reason);
            expect(write.mock.calls).toEqual([
                ['error', 'extension_host.invalid_message', { fields: { reason } }],
            ]);
        },
    );
});
