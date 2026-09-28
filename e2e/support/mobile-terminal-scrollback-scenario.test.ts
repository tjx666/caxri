import { describe, expect, it } from 'vitest';

import {
    hasEarlierLine,
    SCROLLBACK_LINE_COUNT,
    scrollbackLineLabel,
} from './mobile-terminal-scrollback-scenario';

describe('scrollbackLineLabel', () => {
    it('zero-pads the line number to a fixed width', () => {
        expect(scrollbackLineLabel(1)).toBe('Scrollback line 0001');
        expect(scrollbackLineLabel(150)).toBe('Scrollback line 0150');
    });

    it('matches the last line printed for the configured scrollback size', () => {
        expect(scrollbackLineLabel(SCROLLBACK_LINE_COUNT)).toBe('Scrollback line 0150');
    });
});

describe('hasEarlierLine', () => {
    it('is true once a rendered line is strictly earlier than the threshold', () => {
        const rendered = ['Scrollback line 0100', 'Scrollback line 0101', 'Scrollback line 0102'];
        expect(hasEarlierLine(rendered, 145)).toBe(true);
    });

    it('is false when every rendered line is at or after the threshold', () => {
        const rendered = ['Scrollback line 0145', 'Scrollback line 0150'];
        expect(hasEarlierLine(rendered, 145)).toBe(false);
    });

    it('ignores non-matching rendered content, such as a shell prompt or a jump-latest affordance', () => {
        const rendered = ['', '~ %', 'Scrollback line 0150'];
        expect(hasEarlierLine(rendered, 145)).toBe(false);
    });

    it('tolerates the fixed-width padding xterm rows carry in their text content', () => {
        const rendered = [`Scrollback line 0090${' '.repeat(20)}`];
        expect(hasEarlierLine(rendered, 145)).toBe(true);
    });
});
