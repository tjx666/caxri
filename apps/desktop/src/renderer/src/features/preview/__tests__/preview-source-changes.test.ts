import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: unknown) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: unknown) => void) => {
            state.handler = handler;
            return () => {
                state.handler = undefined;
            };
        }),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { onEvent: mocks.onEvent } }));

import { isPreviewSourceChange, subscribePreviewSourceChanges } from '../preview-source-changes';

const source = { workbenchProjectId: 'project-1', path: '/p/manual.pdf' };

function changed(changes: Array<{ kind: 'create' | 'delete' | 'update'; path: string }>) {
    return {
        sessionId: 'session-1',
        workbenchProjectId: 'project-1',
        overflow: false,
        changes,
    };
}

afterEach(() => vi.useRealTimers());

describe('isPreviewSourceChange', () => {
    it('matches a rewrite of the previewed file in its Workbench Root', () => {
        expect(
            isPreviewSourceChange(changed([{ kind: 'update', path: source.path }]), source),
        ).toBe(true);
        expect(
            isPreviewSourceChange(changed([{ kind: 'create', path: source.path }]), source),
        ).toBe(true);
    });

    it('ignores deletions, other files, other roots, and overflowed batches', () => {
        expect(
            isPreviewSourceChange(changed([{ kind: 'delete', path: source.path }]), source),
        ).toBe(false);
        expect(
            isPreviewSourceChange(changed([{ kind: 'update', path: '/p/other.pdf' }]), source),
        ).toBe(false);
        expect(
            isPreviewSourceChange(
                {
                    ...changed([{ kind: 'update', path: source.path }]),
                    workbenchProjectId: 'project-2',
                },
                source,
            ),
        ).toBe(false);
        expect(isPreviewSourceChange({ ...changed([]), overflow: true }, source)).toBe(false);
    });
});

describe('subscribePreviewSourceChanges', () => {
    it('reports one change per settled burst of watcher events', () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const unsubscribe = subscribePreviewSourceChanges(source, onChange);
        for (let index = 0; index < 3; index += 1)
            mocks.state.handler?.({
                event: 'files.changed',
                payload: changed([{ kind: 'update', path: source.path }]),
            });
        expect(onChange).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(onChange).toHaveBeenCalledOnce();
        unsubscribe();
        expect(mocks.state.handler).toBeUndefined();
    });

    it('follows an external document by the ID Main issued, not by path (#2211)', () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const unsubscribe = subscribePreviewSourceChanges(
            { externalDocumentId: 'doc-1' },
            onChange,
        );
        mocks.state.handler?.({
            event: 'externalDocument.changed',
            payload: { documentId: 'doc-2' },
        });
        mocks.state.handler?.({
            event: 'files.changed',
            payload: changed([{ kind: 'update', path: source.path }]),
        });
        vi.advanceTimersByTime(250);
        expect(onChange).not.toHaveBeenCalled();
        mocks.state.handler?.({
            event: 'externalDocument.changed',
            payload: { documentId: 'doc-1' },
        });
        vi.advanceTimersByTime(250);
        expect(onChange).toHaveBeenCalledOnce();
        unsubscribe();
    });
});
