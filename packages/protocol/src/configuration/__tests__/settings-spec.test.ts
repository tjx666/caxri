import { describe, expect, it } from 'vitest';

import { MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '../../domain/domain.js';
import { MAX_LONG_PASTE_BYTES } from '../../domain/terminal-long-paste.js';
import { settingsSpec } from '../settings-spec.js';

describe('settingsSpec', () => {
    it('keeps the maximum threshold inside native input while allowing larger saved pastes', () => {
        const threshold = settingsSpec.find((spec) => spec.key === 'terminal.longPasteThreshold');
        expect(threshold).toMatchObject({
            kind: 'integer',
            max: MAX_TERMINAL_INPUT_PAYLOAD_LENGTH - 12,
        });
        expect(MAX_LONG_PASTE_BYTES).toBeGreaterThan(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH);
    });
});
