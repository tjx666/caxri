import type { WorkItem } from '@shared/work-item';
import { describe, expect, it } from 'vitest';

import { nextWorkItem } from '../tab-navigation';

const terminal = (id: string): WorkItem => ({ kind: 'terminal', terminalId: id });
const editor = (path: string): WorkItem => ({ kind: 'editor', path });

describe('nextWorkItem', () => {
    it('steps forward and wraps from the last item to the first', () => {
        const items = [terminal('a'), terminal('b'), editor('/x')];
        expect(nextWorkItem(items, terminal('a'), 1)).toEqual(terminal('b'));
        expect(nextWorkItem(items, terminal('b'), 1)).toEqual(editor('/x'));
        expect(nextWorkItem(items, editor('/x'), 1)).toEqual(terminal('a'));
    });

    it('steps backward and wraps from the first item to the last', () => {
        const items = [terminal('a'), terminal('b'), editor('/x')];
        expect(nextWorkItem(items, terminal('a'), -1)).toEqual(editor('/x'));
        expect(nextWorkItem(items, editor('/x'), -1)).toEqual(terminal('b'));
    });

    it('returns undefined for an empty tab strip', () => {
        expect(nextWorkItem([], undefined, 1)).toBeUndefined();
        expect(nextWorkItem([], terminal('a'), -1)).toBeUndefined();
    });

    it('falls back to the first item forward and the last item backward when nothing is active', () => {
        const items = [terminal('a'), editor('/x'), editor('/y')];
        expect(nextWorkItem(items, undefined, 1)).toEqual(terminal('a'));
        expect(nextWorkItem(items, undefined, -1)).toEqual(editor('/y'));
    });

    it('falls back the same way when the active item no longer exists in the strip', () => {
        const items = [terminal('a'), terminal('b')];
        expect(nextWorkItem(items, terminal('stale'), 1)).toEqual(terminal('a'));
    });

    it('is a no-op cycle for a single-item strip', () => {
        const items = [terminal('only')];
        expect(nextWorkItem(items, terminal('only'), 1)).toEqual(terminal('only'));
        expect(nextWorkItem(items, terminal('only'), -1)).toEqual(terminal('only'));
    });
});
