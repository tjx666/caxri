import { describe, expect, it } from 'vitest';

import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';

describe('mobile check waits', () => {
    it('refuse an id Android semantics never expose instead of timing out or passing at once', () => {
        expect(() => waitForCheck('emulator-5554', 'agent-chat-usage-hitRate')).toThrow(
            /never expose check id agent-chat-usage-hitRate/u,
        );
        expect(() => waitForNoCheck('emulator-5554', 'agent-chat-usage-hitRate')).toThrow(
            /lowercase kebab-case/u,
        );
    });
});
