import { useState } from 'react';

/**
 * Every key a list has shown, and the keys its latest change showed for the first time.
 */
export interface EnteringKeys {
    signature: string;
    seen: ReadonlySet<string>;
    entering: ReadonlySet<string>;
}

/**
 * Keys never hold a newline, so the joined list identifies its contents and order.
 */
const signatureOf = (keys: readonly string[]) => keys.join('\n');

/**
 * The state for a list that starts with `keys`: all of them count as seen, none as entering.
 */
export function initialEnteringKeys(keys: readonly string[]): EnteringKeys {
    return { signature: signatureOf(keys), seen: new Set(keys), entering: new Set() };
}

/**
 * Keeps `previous` while the list is unchanged; otherwise marks the keys it has never shown as entering.
 */
export function nextEnteringKeys(previous: EnteringKeys, keys: readonly string[]): EnteringKeys {
    const signature = signatureOf(keys);
    if (signature === previous.signature) return previous;
    const entering = new Set(keys.filter((key) => !previous.seen.has(key)));
    return { signature, seen: new Set([...previous.seen, ...keys]), entering };
}

/**
 * The keys in `keys` showing for the first time since the component mounted. Keys present at mount count as seen, so
 * opening a Chat with finished work animates nothing; a key stays seen after it leaves, so a phrase that steps aside
 * for a running title and comes back does not enter again.
 */
export function useEnteringKeys(keys: readonly string[]): ReadonlySet<string> {
    const [state, setState] = useState(() => initialEnteringKeys(keys));
    const next = nextEnteringKeys(state, keys);
    // Adjusting state while rendering, as React documents for state derived from a changed prop, so a new phrase mounts
    // already knowing it enters.
    if (next !== state) setState(next);
    return next.entering;
}
