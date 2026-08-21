import { describe, expect, it } from 'vitest';

import { terminalTabLabel } from '../terminal-title';

describe('terminalTabLabel', () => {
    it('drops the prompt host prefix that is identical on every local tab', () => {
        expect(terminalTabLabel('tj@macbook:~/code')).toBe('~/code');
    });

    it('compresses a deep path down to its identifying tail', () => {
        expect(terminalTabLabel('tj@macbook:~/code/caxri-worktrees/feat-work-tab-layout')).toBe(
            '~/…/feat-work-tab-layout',
        );
        expect(terminalTabLabel('/Users/tj/code/caxri')).toBe('/…/caxri');
        expect(terminalTabLabel('../code/caxri-worktrees/feat-x')).toBe('../…/feat-x');
    });

    it('compresses a path whose directory names contain spaces', () => {
        expect(terminalTabLabel('tj@macbook:~/Code/My Project/src/app')).toBe('~/…/app');
    });

    it('ignores a trailing slash rather than compressing to an empty tail', () => {
        expect(terminalTabLabel('~/code/caxri-worktrees/feat-x/')).toBe('~/…/feat-x');
    });

    it('leaves a path short enough that the ellipsis would save nothing', () => {
        expect(terminalTabLabel('~/code')).toBe('~/code');
        expect(terminalTabLabel('~/code/caxri')).toBe('~/code/caxri');
    });

    it('leaves anything that is not a rooted path intact', () => {
        expect(terminalTabLabel('Fix the tab strip / verify layout')).toBe(
            'Fix the tab strip / verify layout',
        );
        expect(terminalTabLabel('Fix/verify/now/please')).toBe('Fix/verify/now/please');
        expect(terminalTabLabel('https://example.com/a/b')).toBe('https://example.com/a/b');
    });

    it('keeps a title that is only a host prefix rather than rendering an empty tab', () => {
        expect(terminalTabLabel('tj@macbook:')).toBe('tj@macbook:');
    });

    it('passes through a plain title', () => {
        expect(terminalTabLabel('Shell')).toBe('Shell');
    });
});
