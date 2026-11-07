import { describe, expect, it } from 'vitest';

import { collapseAndroidStatusBar } from '../mobile-acceptance-status-bar';

describe('mobile acceptance status bar', () => {
    it('collapses the notification shade through the status bar service', () => {
        const calls: string[][] = [];
        collapseAndroidStatusBar((arguments_) => calls.push(arguments_));
        expect(calls).toEqual([['shell', 'cmd', 'statusbar', 'collapse']]);
    });
});
