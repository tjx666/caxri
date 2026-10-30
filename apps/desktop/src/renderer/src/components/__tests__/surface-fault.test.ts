import { describe, expect, it } from 'vitest';

import { releaseSurfaceFault, shouldFailSurface, SURFACE_FAULT_KEY } from '../surface-fault';

function storageWith(value?: string) {
    const values = new Map<string, string>(value === undefined ? [] : [[SURFACE_FAULT_KEY, value]]);
    return {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => {
            values.delete(key);
        },
        has: () => values.has(SURFACE_FAULT_KEY),
    };
}

describe('shouldFailSurface', () => {
    it('stays inert when the key is absent or names another scope', () => {
        expect(shouldFailSurface(storageWith(), {}, 'terminal', 'a')).toBe(false);
        expect(shouldFailSurface(storageWith('settings'), {}, 'terminal', 'a')).toBe(false);
    });

    it('fails only the first surface of the armed scope and consumes the key', () => {
        const storage = storageWith('chat-entry');
        const memo = {};
        expect(shouldFailSurface(storage, memo, 'chat-entry', 'one')).toBe(true);
        expect(storage.has()).toBe(false);
        // A re-render of the same surface still agrees; a sibling renders normally.
        expect(shouldFailSurface(storage, memo, 'chat-entry', 'one')).toBe(true);
        expect(shouldFailSurface(storage, memo, 'chat-entry', 'two')).toBe(false);
    });

    it('renders normally again once Retry releases the fault', () => {
        const memo = {};
        const storage = storageWith('terminal');
        shouldFailSurface(storage, memo, 'terminal', 'a');
        releaseSurfaceFault(memo, 'terminal', 'other');
        expect(shouldFailSurface(storage, memo, 'terminal', 'a')).toBe(true);
        releaseSurfaceFault(memo, 'terminal', 'a');
        expect(shouldFailSurface(storage, memo, 'terminal', 'a')).toBe(false);
    });
});
