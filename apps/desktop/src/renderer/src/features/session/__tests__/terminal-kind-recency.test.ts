import type { TerminalKind } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { orderTerminalKindsByRecency, promoteTerminalKind } from '../terminal-kind-recency';

const STORAGE_KEY = 'caxri.terminal-kind-recency';
const CATALOG_ORDER: TerminalKind[] = ['claude', 'codex', 'grok', 'shell'];

/**
 * The store reads its persisted order once, while the module initializes. Reaching a persisted value therefore means
 * installing storage first and importing the module fresh, not mutating an already-built store.
 */
async function loadStore(persisted?: unknown) {
    const entries = new Map<string, string>();
    if (persisted !== undefined) entries.set(STORAGE_KEY, JSON.stringify(persisted));
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    });
    vi.resetModules();
    const module = await import('../terminal-kind-recency');
    return { entries, store: module.useTerminalKindRecencyStore };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('orderTerminalKindsByRecency', () => {
    it('falls back to catalog order when nothing was ever chosen', () => {
        expect(orderTerminalKindsByRecency([])).toEqual(CATALOG_ORDER);
    });

    it('appends the kinds the list never mentioned, in catalog order', () => {
        expect(orderTerminalKindsByRecency(['shell'])).toEqual([
            'shell',
            'claude',
            'codex',
            'grok',
        ]);
    });

    it('keeps the first occurrence of a repeated kind', () => {
        expect(orderTerminalKindsByRecency(['grok', 'claude', 'grok'])).toEqual([
            'grok',
            'claude',
            'codex',
            'shell',
        ]);
    });

    it('drops entries that are not Terminal kinds', () => {
        expect(orderTerminalKindsByRecency(['codex', 'gemini', 42, null, {}])).toEqual([
            'codex',
            'claude',
            'grok',
            'shell',
        ]);
    });

    it('is idempotent, so a persisted order survives a reload unchanged', () => {
        const once = orderTerminalKindsByRecency(['shell', 'grok']);
        expect(orderTerminalKindsByRecency(once)).toEqual(once);
    });
});

describe('promoteTerminalKind', () => {
    it('moves the chosen kind to the front', () => {
        expect(promoteTerminalKind(CATALOG_ORDER, 'grok')).toEqual([
            'grok',
            'claude',
            'codex',
            'shell',
        ]);
    });

    it('leaves the relative order of the rest untouched', () => {
        expect(promoteTerminalKind(['shell', 'grok', 'claude', 'codex'], 'claude')).toEqual([
            'claude',
            'shell',
            'grok',
            'codex',
        ]);
    });
});

describe('useTerminalKindRecencyStore', () => {
    it('starts in catalog order without a persisted entry', async () => {
        const { store } = await loadStore();
        expect(store.getState().order).toEqual(CATALOG_ORDER);
    });

    it('restores a persisted order', async () => {
        const { store } = await loadStore(['codex', 'shell']);
        expect(store.getState().order).toEqual(['codex', 'shell', 'claude', 'grok']);
    });

    it('falls back to catalog order for a corrupt persisted entry', async () => {
        const { store } = await loadStore({ recent: 'codex' });
        expect(store.getState().order).toEqual(CATALOG_ORDER);
    });

    it('promotes and persists a recorded kind', async () => {
        const { entries, store } = await loadStore();
        store.getState().recordTerminalKind('grok');
        expect(store.getState().order).toEqual(['grok', 'claude', 'codex', 'shell']);
        expect(entries.get(STORAGE_KEY)).toBe('["grok","claude","codex","shell"]');
    });

    it('keeps the same state identity when the leading kind is chosen again', async () => {
        const { store } = await loadStore(['codex']);
        const before = store.getState().order;
        store.getState().recordTerminalKind('codex');
        expect(store.getState().order).toBe(before);
    });
});
