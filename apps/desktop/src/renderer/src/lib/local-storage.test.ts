import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readLocalStorageEntry,
    readLocalStorageJson,
    writeLocalStorageJson,
} from './local-storage';

/**
 * The suite runs under Vitest's `node` environment, so `window` and `localStorage` are genuinely absent until a test
 * installs them. That absence is itself one of the behaviors under test.
 */
function stubStorage(
    entries: Map<string, string>,
    overrides: Partial<Pick<Storage, 'getItem' | 'setItem'>> = {},
): void {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
        ...overrides,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('readLocalStorageEntry', () => {
    it('reports no entry when storage is unavailable', () => {
        expect(readLocalStorageEntry('caxri.example')).toBeUndefined();
    });

    it('returns a stored entry', () => {
        stubStorage(new Map([['caxri.example', 'stored']]));
        expect(readLocalStorageEntry('caxri.example')).toBe('stored');
    });

    it('reports no entry for an unset key', () => {
        stubStorage(new Map());
        expect(readLocalStorageEntry('caxri.example')).toBeUndefined();
    });

    it('reports no entry when the read throws', () => {
        stubStorage(new Map(), {
            getItem: () => {
                throw new Error('SecurityError');
            },
        });
        expect(readLocalStorageEntry('caxri.example')).toBeUndefined();
    });
});

describe('readLocalStorageJson', () => {
    it('parses a stored value', () => {
        stubStorage(new Map([['caxri.example', '{"width":240}']]));
        expect(readLocalStorageJson('caxri.example')).toEqual({ width: 240 });
    });

    it('reports no value for a corrupt entry instead of throwing', () => {
        stubStorage(new Map([['caxri.example', '{not json']]));
        expect(readLocalStorageJson('caxri.example')).toBeUndefined();
    });
});

describe('writeLocalStorageJson', () => {
    it('serializes the value under the key', () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        writeLocalStorageJson('caxri.example', ['claude', 'shell']);
        expect(entries.get('caxri.example')).toBe('["claude","shell"]');
    });

    it('swallows a full or disabled store', () => {
        stubStorage(new Map(), {
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
        });
        expect(() => writeLocalStorageJson('caxri.example', { width: 240 })).not.toThrow();
    });

    it('does nothing when storage is unavailable', () => {
        expect(() => writeLocalStorageJson('caxri.example', { width: 240 })).not.toThrow();
    });
});
