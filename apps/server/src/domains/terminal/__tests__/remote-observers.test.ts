import { describe, expect, it } from 'vitest';

import { TerminalRemoteObservers } from '../remote-observers';

describe('TerminalRemoteObservers', () => {
    it('counts a Terminal as observed until every observer of it has unobserved', () => {
        const observers = new TerminalRemoteObservers();
        expect(observers.has('terminal-1')).toBe(false);
        observers.add('terminal-1', 'phone-a');
        observers.add('terminal-1', 'phone-b');
        observers.remove('terminal-1', 'phone-a');
        expect(observers.has('terminal-1')).toBe(true);
        observers.remove('terminal-1', 'phone-b');
        expect(observers.has('terminal-1')).toBe(false);
    });

    it('counts a repeated observe from one subscription once', () => {
        const observers = new TerminalRemoteObservers();
        observers.add('terminal-1', 'phone-a');
        observers.add('terminal-1', 'phone-a');
        observers.remove('terminal-1', 'phone-a');
        expect(observers.has('terminal-1')).toBe(false);
        // An unobserve with nothing recorded is a no-op.
        observers.remove('terminal-2', 'phone-a');
        expect(observers.has('terminal-2')).toBe(false);
    });
});
