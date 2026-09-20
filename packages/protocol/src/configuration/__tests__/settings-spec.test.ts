import { describe, expect, it } from 'vitest';

import { MAX_LONG_PASTE_CHARACTERS } from '../../domain/terminal-long-paste.js';
import { settingsSpec } from '../settings-spec.js';

describe('settingsSpec', () => {
    /**
     * `terminal.longPasteThreshold` is the only off switch for the long-paste transformation: raising it to the
     * slider's maximum works only while that maximum still matches the protocol's paste ceiling. The spec inlines the
     * number because importing it would close an import cycle, so this test owns the link between the two.
     */
    it('lets the long paste threshold reach the protocol paste ceiling', () => {
        const threshold = settingsSpec.find((spec) => spec.key === 'terminal.longPasteThreshold');
        expect(threshold).toMatchObject({ kind: 'integer', max: MAX_LONG_PASTE_CHARACTERS });
    });
});
