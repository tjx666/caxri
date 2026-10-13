import { describe, expect, it } from 'vitest';

import { ChatMobileWatchers } from '../chat-mobile-watchers';

describe('ChatMobileWatchers', () => {
    it('keeps a Chat watched until every phone releases it', () => {
        const watchers = new ChatMobileWatchers();
        watchers.watch('chat');
        watchers.watch('chat');
        watchers.unwatch('chat');
        expect(watchers.has('chat')).toBe(true);
        watchers.unwatch('chat');
        expect(watchers.has('chat')).toBe(false);
        watchers.unwatch('chat');
        expect(watchers.has('chat')).toBe(false);
    });
});
