import { describe, expect, it } from 'vitest';

import { prepareMobileReducedMotion } from '../mobile-acceptance-motion';

describe('mobile acceptance reduced motion', () => {
    it('removes transition animations for the batch and restores the previous scale once', () => {
        const actions: string[] = [];
        const restore = prepareMobileReducedMotion('emulator-5554', {
            readDevice: () => '1.0\n',
            runDevice: (arguments_) => actions.push(arguments_.join(' ')),
        });
        restore();
        restore();

        expect(actions).toEqual([
            'shell settings put global transition_animation_scale 0',
            'shell settings put global transition_animation_scale 1.0',
        ]);
    });

    it('deletes the setting again when the emulator never had one', () => {
        const actions: string[] = [];
        const restore = prepareMobileReducedMotion('emulator-5554', {
            readDevice: () => 'null',
            runDevice: (arguments_) => actions.push(arguments_.join(' ')),
        });
        restore();

        expect(actions.at(-1)).toBe('shell settings delete global transition_animation_scale');
    });

    it('refuses a device that is not an explicit emulator', () => {
        expect(() =>
            prepareMobileReducedMotion('R5CT1234', {
                readDevice: () => '1.0',
                runDevice: () => {},
            }),
        ).toThrow('Reduced motion requires an explicit disposable emulator');
    });
});
