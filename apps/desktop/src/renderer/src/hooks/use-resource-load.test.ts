import { describe, expect, it } from 'vitest';

import { currentResourceLoadFailure, isCurrentResourceLoadScope } from './use-resource-load';

const load = (): Promise<undefined> => Promise.resolve(undefined);
const scope = { target: '/repo/a.md', enabled: true, load, attempt: 0 };

describe('Resource load scope reconciliation', () => {
    it('keeps the scope in state when this render asks for the same read', () => {
        expect(isCurrentResourceLoadScope(scope, { ...scope })).toBe(true);
    });

    it('starts a new read for a new target, a new loader, or a retry', () => {
        expect(isCurrentResourceLoadScope(scope, { ...scope, target: '/repo/b.md' })).toBe(false);
        // Identity, not equality: a caller whose closure changed is reading something else even when the path matches.
        expect(
            isCurrentResourceLoadScope(scope, {
                ...scope,
                load: (): Promise<undefined> => Promise.resolve(undefined),
            }),
        ).toBe(false);
        expect(isCurrentResourceLoadScope(scope, { ...scope, attempt: 1 })).toBe(false);
    });

    it('starts a new read when the surface is enabled or disabled', () => {
        expect(isCurrentResourceLoadScope(scope, { ...scope, enabled: false })).toBe(false);
    });
});

describe('Resource load failure publication', () => {
    const failure = { error: new Error('synthetic read failure') };

    it('shows the failure the current scope asked for', () => {
        expect(currentResourceLoadFailure({ scope, failure }, scope, true)).toBe(failure);
    });

    it('shows nothing before the first read answers', () => {
        expect(currentResourceLoadFailure(undefined, scope, true)).toBeUndefined();
    });

    it('discards a result that belongs to an abandoned read', () => {
        // The retried attempt is a different scope object, so the earlier failure cannot paint over it.
        const retried = { ...scope, attempt: 1 };
        expect(currentResourceLoadFailure({ scope, failure }, retried, true)).toBeUndefined();
        // Same values, different identity: a target change that happens to produce an equal scope is still new.
        expect(currentResourceLoadFailure({ scope, failure }, { ...scope }, true)).toBeUndefined();
    });

    it('hides a failure the caller has since disabled', () => {
        expect(currentResourceLoadFailure({ scope, failure }, scope, false)).toBeUndefined();
    });

    it('reports a successful read as no failure at all', () => {
        expect(currentResourceLoadFailure({ scope }, scope, true)).toBeUndefined();
    });
});
