import { expect, it, vi } from 'vitest';

import { disposeGitDiffModels } from '../diff-model-lifecycle';

it('keeps text models alive until Monaco cancels the detached diff computation', () => {
    const events: string[] = [];
    const original = { dispose: () => events.push('original disposed') };
    const modified = { dispose: () => events.push('modified disposed') };
    const editor = {
        setModel: () => {
            events.push('detached');
        },
        dispose: () => events.push('editor disposed'),
    };
    disposeGitDiffModels(
        editor,
        { dispose: () => events.push('computation cancelled') },
        { original, modified },
    );
    expect(events).toEqual([
        'detached',
        'computation cancelled',
        'editor disposed',
        'original disposed',
        'modified disposed',
    ]);
});

it('releases both text models when Monaco throws out of widget teardown', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: string[] = [];
    const editor = {
        setModel: () => {},
        dispose: () => {
            throw new AggregateError(
                [new Error('InstantiationService has been disposed')],
                'Encountered errors while disposing of store',
            );
        },
    };
    expect(() =>
        disposeGitDiffModels(
            editor,
            { dispose: () => {} },
            {
                original: { dispose: () => events.push('original disposed') },
                modified: { dispose: () => events.push('modified disposed') },
            },
        ),
    ).not.toThrow();
    expect(events).toEqual(['original disposed', 'modified disposed']);
    expect(reported).toHaveBeenCalledOnce();
    reported.mockRestore();
});
