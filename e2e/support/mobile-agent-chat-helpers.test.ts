import { describe, expect, it } from 'vitest';

import { hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';

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

describe('hasCheck', () => {
    const nodes = [{ checkId: 'files-entry-notes.md' }];

    it('finds an exposed id and reports a valid missing one as absent', () => {
        expect(hasCheck(nodes, 'files-entry-notes.md')).toBe(true);
        expect(hasCheck(nodes, 'files-entry-other.md')).toBe(false);
    });

    it('refuses an id the device can never expose instead of polling until a wait times out', () => {
        expect(() => hasCheck(nodes, 'files-entry-README.md')).toThrow(
            /never expose check id files-entry-README.md/u,
        );
    });
});
