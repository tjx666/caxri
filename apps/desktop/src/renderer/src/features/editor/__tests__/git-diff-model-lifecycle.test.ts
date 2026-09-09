import { expect, it } from 'vitest';

import { disposeGitDiffModels } from '../git-diff-model-lifecycle';

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
