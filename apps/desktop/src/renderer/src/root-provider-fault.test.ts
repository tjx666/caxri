import { describe, expect, it } from 'vitest';

import { ROOT_PROVIDER_FAULT_KEY, shouldFailRootProvider } from './root-provider-fault';

function storageWith(value: string | undefined) {
    const data = new Map<string, string>(
        value === undefined ? [] : [[ROOT_PROVIDER_FAULT_KEY, value]],
    );
    return {
        data,
        getItem: (key: string) => data.get(key) ?? null,
        removeItem: (key: string) => {
            data.delete(key);
        },
    };
}

describe('shouldFailRootProvider', () => {
    it('stays off without the flag', () => {
        expect(shouldFailRootProvider(storageWith(undefined), {})).toBe(false);
    });

    it('fires once per memo and clears the flag so Reload renders normally', () => {
        const storage = storageWith('1');
        const memo = {};
        expect(shouldFailRootProvider(storage, memo)).toBe(true);
        expect(storage.data.has(ROOT_PROVIDER_FAULT_KEY)).toBe(false);
        // React's retry of the same pass still sees the decision.
        expect(shouldFailRootProvider(storage, memo)).toBe(true);
        // A fresh page load has a new memo and no flag.
        expect(shouldFailRootProvider(storage, {})).toBe(false);
    });
});
