import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createStore, installStoreInspector } from './store';

interface CounterState {
    count: number;
    label: string;
    increment(): void;
}

const useCounterStore = createStore<CounterState>('test-counter', (set) => ({
    count: 0,
    label: 'counter',
    increment: () => set((state) => ({ count: state.count + 1 })),
}));

describe('createStore', () => {
    beforeAll(() => {
        installStoreInspector();
    });

    beforeEach(() => {
        useCounterStore.setState({ count: 0 });
    });

    it('returns a working zustand store', () => {
        useCounterStore.getState().increment();
        expect(useCounterStore.getState().count).toBe(1);
    });

    it('registers the store under its name for a live debugging session', () => {
        expect(globalThis.__caxriStores.names()).toContain('test-counter');
    });

    it('reports values without the actions a debugger cannot serialize', () => {
        useCounterStore.getState().increment();
        expect(globalThis.__caxriStores.getState('test-counter')).toEqual({
            count: 1,
            label: 'counter',
        });
        expect(
            JSON.stringify(globalThis.__caxriStores.snapshot()['test-counter']),
        ).toMatchInlineSnapshot(`"{"count":1,"label":"counter"}"`);
    });

    it('reports nothing for a store whose module has not been imported', () => {
        expect(globalThis.__caxriStores.getState('never-imported')).toBeUndefined();
    });

    it('offers no way to write state back', () => {
        expect(globalThis.__caxriStores).not.toHaveProperty('setState');
    });
});
