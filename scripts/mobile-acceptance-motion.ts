const TRANSITION_SCALE = ['settings', 'get', 'global', 'transition_animation_scale'];

export interface MobileMotionCommands {
    readDevice: (arguments_: string[]) => string;
    runDevice: (arguments_: string[]) => void;
}

/**
 * Sets the emulator's transition animation scale to `value` and returns an idempotent restore of the previous one.
 */
function overrideTransitionScale(
    serial: string,
    commands: MobileMotionCommands,
    value: string,
): () => void {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Motion settings require an explicit disposable emulator');
    const previous = commands.readDevice(['shell', ...TRANSITION_SCALE]).trim();
    let isRestorePending = true;
    const restore = (): void => {
        if (!isRestorePending) return;
        if (previous === 'null' || previous === '')
            commands.runDevice([
                'shell',
                'settings',
                'delete',
                'global',
                'transition_animation_scale',
            ]);
        else
            commands.runDevice([
                'shell',
                'settings',
                'put',
                'global',
                'transition_animation_scale',
                previous,
            ]);
        isRestorePending = false;
    };
    try {
        commands.runDevice([
            'shell',
            'settings',
            'put',
            'global',
            'transition_animation_scale',
            value,
        ]);
    } catch (error) {
        restore();
        throw error;
    }
    return restore;
}

/**
 * Turns on the emulator's "remove animations" setting for one case batch and returns its idempotent restore.
 *
 * Running Chat work (a tool row waiting on approval, the activity line) sweeps an endless shimmer. UIAutomator waits
 * for an idle window before every semantic dump, so a visible shimmer makes each dump fail and the scenario can no
 * longer find or tap a control. Reanimated reads a zero `transition_animation_scale` as reduced motion, which leaves
 * that text static while every label stays the same. Set before the app starts, because Reanimated reads it once.
 */
export const prepareMobileReducedMotion = (
    serial: string,
    commands: MobileMotionCommands,
): (() => void) => overrideTransitionScale(serial, commands, '0');

/**
 * Turns animations back on for one case inside a reduced-motion batch, so its recording shows the shimmer and other
 * motion as a user sees it, and returns the restore to the batch's setting. The runner calls it after clearing the app
 * and before the scenario starts it, which is when Reanimated reads the setting.
 */
export const prepareMobileLiveMotion = (
    serial: string,
    commands: MobileMotionCommands,
): (() => void) => overrideTransitionScale(serial, commands, '1');

/**
 * Adds reduced motion to an already prepared fixture IME, so both share the batch lifetime and its retried cleanup.
 */
export async function withMobileReducedMotion(
    serial: string,
    commands: MobileMotionCommands,
    cleanupIme: () => Promise<void>,
): Promise<() => Promise<void>> {
    let restoreMotion: () => void;
    try {
        restoreMotion = prepareMobileReducedMotion(serial, commands);
    } catch (error) {
        await cleanupIme();
        throw error;
    }
    return async () => {
        try {
            restoreMotion();
        } finally {
            await cleanupIme();
        }
    };
}
