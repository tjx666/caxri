import { describe, expect, it } from 'vitest';

import { MOBILE_FIXTURE_IME_ID, prepareMobileFixtureIme } from '../mobile-acceptance-ime';

const previousIme = 'com.android.inputmethod.latin/.LatinIME';

describe('mobile acceptance fixture IME', () => {
    it('restores the original default and removes the fixture after a case batch', async () => {
        const actions: string[] = [];
        let currentIme = previousIme;
        const cleanup = await prepareMobileFixtureIme('emulator-5554', {
            build: () => actions.push('build'),
            readDevice: (arguments_) =>
                arguments_[1] === 'ime' ? MOBILE_FIXTURE_IME_ID : currentIme,
            runDevice: (arguments_) => {
                actions.push(arguments_.join(' '));
                if (arguments_[1] === 'ime' && arguments_[2] === 'set') currentIme = arguments_[3];
            },
        });

        expect(currentIme).toBe(MOBILE_FIXTURE_IME_ID);
        await cleanup();
        await cleanup();

        expect(currentIme).toBe(previousIme);
        expect(actions).toEqual([
            'build',
            expect.stringMatching(/^install -r .*fixture-ime\.apk$/u),
            `shell ime enable ${MOBILE_FIXTURE_IME_ID}`,
            `shell ime set ${MOBILE_FIXTURE_IME_ID}`,
            `shell ime set ${previousIme}`,
            `shell ime disable ${MOBILE_FIXTURE_IME_ID}`,
            'uninstall caxri.acceptance.ime',
        ]);
    });

    it('restores the original default after selection fails with a device side effect', async () => {
        const actions: string[] = [];
        let currentIme = previousIme;

        await expect(
            prepareMobileFixtureIme('emulator-5554', {
                build: () => actions.push('build'),
                readDevice: (arguments_) =>
                    arguments_[1] === 'ime' ? MOBILE_FIXTURE_IME_ID : currentIme,
                runDevice: (arguments_) => {
                    actions.push(arguments_.join(' '));
                    if (arguments_[1] !== 'ime' || arguments_[2] !== 'set') return;
                    currentIme = arguments_[3];
                    if (currentIme === MOBILE_FIXTURE_IME_ID)
                        throw new Error('selection failed after changing the default');
                },
            }),
        ).rejects.toThrow('selection failed after changing the default');

        expect(currentIme).toBe(previousIme);
        expect(actions.slice(-3)).toEqual([
            `shell ime set ${previousIme}`,
            `shell ime disable ${MOBILE_FIXTURE_IME_ID}`,
            'uninstall caxri.acceptance.ime',
        ]);
    });

    it('rejects a real phone before reading or changing its input method', async () => {
        let isTouched = false;
        await expect(
            prepareMobileFixtureIme('192.0.2.1:5555', {
                build: () => {
                    isTouched = true;
                },
                readDevice: () => {
                    isTouched = true;
                    return previousIme;
                },
                runDevice: () => {
                    isTouched = true;
                },
            }),
        ).rejects.toThrow('explicit disposable emulator');
        expect(isTouched).toBe(false);
    });

    it('does not replace or uninstall a pre-existing fixture package', async () => {
        const actions: string[] = [];
        await expect(
            prepareMobileFixtureIme('emulator-5554', {
                build: () => actions.push('build'),
                readDevice: (arguments_) =>
                    arguments_[1] === 'pm' ? 'package:caxri.acceptance.ime' : previousIme,
                runDevice: (arguments_) => actions.push(arguments_.join(' ')),
            }),
        ).rejects.toThrow('already contains the fixture IME package');
        expect(actions).toEqual([]);
    });

    it('retries restoring the original default after the first cleanup attempt fails', async () => {
        const actions: string[] = [];
        let currentIme = previousIme;
        let isFailRestoreOnce = true;
        const cleanup = await prepareMobileFixtureIme('emulator-5554', {
            build: () => {},
            readDevice: (arguments_) =>
                arguments_[1] === 'ime' ? MOBILE_FIXTURE_IME_ID : currentIme,
            runDevice: (arguments_) => {
                actions.push(arguments_.join(' '));
                if (arguments_[1] !== 'ime' || arguments_[2] !== 'set') return;
                if (isFailRestoreOnce && arguments_[3] === previousIme) {
                    isFailRestoreOnce = false;
                    throw new Error('restore failed once');
                }
                currentIme = arguments_[3];
            },
        });

        await expect(cleanup()).rejects.toThrow('Mobile fixture IME cleanup failed');
        expect(currentIme).toBe(MOBILE_FIXTURE_IME_ID);
        expect(actions).not.toContain('uninstall caxri.acceptance.ime');
        await cleanup();
        expect(currentIme).toBe(previousIme);
        expect(actions.filter((action) => action === `shell ime set ${previousIme}`)).toHaveLength(
            2,
        );
        expect(
            actions.filter((action) => action === 'uninstall caxri.acceptance.ime'),
        ).toHaveLength(1);
    });

    it('keeps the fixture installed until a failed disable can be retried', async () => {
        const actions: string[] = [];
        let currentIme = previousIme;
        let isFailDisableOnce = true;
        const cleanup = await prepareMobileFixtureIme('emulator-5554', {
            build: () => {},
            readDevice: (arguments_) =>
                arguments_[1] === 'ime' ? MOBILE_FIXTURE_IME_ID : currentIme,
            runDevice: (arguments_) => {
                actions.push(arguments_.join(' '));
                if (arguments_[1] === 'ime' && arguments_[2] === 'set') currentIme = arguments_[3];
                if (isFailDisableOnce && arguments_[1] === 'ime' && arguments_[2] === 'disable') {
                    isFailDisableOnce = false;
                    throw new Error('disable failed once');
                }
            },
        });

        await expect(cleanup()).rejects.toThrow('cleanup failed at disable');
        expect(currentIme).toBe(previousIme);
        expect(actions).not.toContain('uninstall caxri.acceptance.ime');
        await cleanup();
        expect(
            actions.filter((action) => action === 'uninstall caxri.acceptance.ime'),
        ).toHaveLength(1);
    });

    it('preserves both setup and cleanup errors when rollback cannot restore the default', async () => {
        let currentIme = previousIme;
        let failure: unknown;
        try {
            await prepareMobileFixtureIme('emulator-5554', {
                build: () => {},
                readDevice: (arguments_) =>
                    arguments_[1] === 'ime' ? MOBILE_FIXTURE_IME_ID : currentIme,
                runDevice: (arguments_) => {
                    if (arguments_[1] !== 'ime' || arguments_[2] !== 'set') return;
                    if (arguments_[3] === previousIme) throw new Error('restore failed');
                    currentIme = arguments_[3];
                    throw new Error('setup selection failed');
                },
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
            expect.objectContaining({ message: 'setup selection failed' }),
            expect.objectContaining({
                message: 'Mobile fixture IME cleanup failed at restore',
            }),
        ]);
    });
});
