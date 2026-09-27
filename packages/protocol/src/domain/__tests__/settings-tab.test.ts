import { describe, expect, it } from 'vitest';

import { isSettingsTabPath, isVirtualEditorTabPath, settingsTabPath } from '../index';

describe('settings virtual tab', () => {
    it('is a fixed, opaque path with no encoded data', () => {
        const path = settingsTabPath();

        expect(path).toBe('caxri-settings://workbench');
        expect(isSettingsTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
    });

    it.each(['caxri-settings://', 'caxri-settings://workbench/extra', 'caxri-file-preview://foo'])(
        'rejects anything other than the exact settings path: %s',
        (path) => {
            expect(isSettingsTabPath(path)).toBe(false);
        },
    );
});
