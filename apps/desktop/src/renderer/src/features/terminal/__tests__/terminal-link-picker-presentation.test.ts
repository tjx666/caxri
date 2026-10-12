import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { terminalLinkPickerCopy } from '../terminal-link-picker-presentation';

describe('Terminal link picker copy', () => {
    it('does not claim an empty result while the scan is running', () => {
        expect(terminalLinkPickerCopy(translate, 'detected', false, 'scanning').empty).toBe(
            'Scanning Terminal links…',
        );
        expect(terminalLinkPickerCopy(translate, 'detected', false, 'complete').empty).toContain(
            'No links found',
        );
    });
    it('keeps file and commit candidate guidance separate', () => {
        expect(terminalLinkPickerCopy(translate, 'candidates', false, 'complete').title).toBe(
            'Choose Terminal File',
        );
        expect(terminalLinkPickerCopy(translate, 'candidates', true, 'complete').empty).toBe(
            'No matching repositories.',
        );
    });
});
