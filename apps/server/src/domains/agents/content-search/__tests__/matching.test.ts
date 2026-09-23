import { expect, it } from 'vitest';

import { contentMatchSnippet } from '../matching';

it('uses case-insensitive literal matching and bounds excerpts', () => {
    expect(contentMatchSnippet('A literal [target] appears', '[TARGET]')).toContain('[target]');
    expect(contentMatchSnippet('abc', '.*')).toBeUndefined();
    expect(
        contentMatchSnippet(`${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`, 'needle')!.length,
    ).toBeLessThanOrEqual(302);
});
