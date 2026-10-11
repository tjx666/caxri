import { createContext, useContext } from 'react';

import type { ReadCache } from './read-cache-store';
import { createReadCache } from './read-cache-store';

/**
 * Without a provider nothing is saved or found, so a screen rendered outside the app shell behaves as before the cache.
 */
const noReadCache = createReadCache({
    clear: () => {},
    list: () => [],
    read: () => Promise.resolve(null),
    remove: () => {},
    write: () => {},
});

export const ReadCacheContext = createContext<ReadCache>(noReadCache);

export const useReadCache = (): ReadCache => useContext(ReadCacheContext);
