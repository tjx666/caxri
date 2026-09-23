import { describe, expect, it } from 'vitest';

import { terminalLinkPickerCopy } from '../terminal-link-picker-presentation';

describe('Terminal link picker copy', () => {
    it('does not claim an empty result while the scan is running', () => {
        expect(terminalLinkPickerCopy('detected', false, 'scanning').empty).toBe(
            'Scanning Terminal links…',
        );
        expect(terminalLinkPickerCopy('detected', false, 'complete').empty).toContain(
            'No links found',
        );
    });
    it('keeps file and commit candidate guidance separate', () => {
        expect(terminalLinkPickerCopy('candidates', false, 'complete').title).toBe(
            'Choose Terminal File',
        );
        expect(terminalLinkPickerCopy('candidates', true, 'complete').empty).toBe(
            'No matching repositories.',
        );
    });
});
