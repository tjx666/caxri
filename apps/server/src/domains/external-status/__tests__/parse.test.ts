import { describe, expect, it } from 'vitest';

import { LINEAR_ISSUE_QUERY, linearStateColor } from '../parse';

describe('Linear workflow state color', () => {
    it.each(['#5E6AD2', '#5e6ad2', '#5E6AD2FF'])('keeps the workspace color %s', (color) => {
        expect(linearStateColor(color)).toBe(color);
    });

    /**
     * The color travels from Linear straight to a `style` attribute on the icon, so anything that is not a hex literal
     * is dropped rather than forwarded. The issue still renders: it just inherits the row's theme color.
     */
    it.each([undefined, '', 'purple', 'rgb(94,106,210)', '#5E6AD', 'url(evil)'])(
        'drops %s, which Caxri cannot render as a color',
        (color) => {
            expect(linearStateColor(color)).toBeUndefined();
        },
    );

    it('asks Linear for the state color alongside its name and type', () => {
        expect(LINEAR_ISSUE_QUERY).toContain('state{name type color}');
    });
});
