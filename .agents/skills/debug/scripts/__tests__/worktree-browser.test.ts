import { describe, expect, it } from 'vitest';

import { browserArguments, browserEnvironment, reportedWorktree } from '../worktree-browser';

describe('worktree-browser', () => {
    it('strips every proxy variable agent-browser would follow and keeps the rest', () => {
        const environment = browserEnvironment({
            ALL_PROXY: 'socks5://proxy',
            HOME: '/home/agent',
            HTTPS_PROXY: 'http://proxy',
            HTTP_PROXY: 'http://proxy',
            all_proxy: 'socks5://proxy',
            http_proxy: 'http://proxy',
            https_proxy: 'http://proxy',
        });

        expect(environment).toEqual({ HOME: '/home/agent' });
    });

    it('pins the recorded port and a session unique to the worktree before the command', () => {
        expect(
            browserArguments({ cdpPort: 9620, worktreeId: '8278d2f6-ee2d-4153' }, [
                'screenshot',
                '/tmp/shot.png',
            ]),
        ).toEqual(['--session', 'caxri-8278d2f6', '--cdp', '9620', 'screenshot', '/tmp/shot.png']);
    });

    it('reads the worktree path from the doubly encoded eval output', () => {
        expect(reportedWorktree('"\\"/work/caxri-feature\\""\n')).toBe('/work/caxri-feature');
        // A window launched outside `switch-worktree dev` has no global.
        expect(reportedWorktree('"undefined"\n')).toBeUndefined();
        expect(reportedWorktree('Error: connection refused')).toBeUndefined();
    });
});
