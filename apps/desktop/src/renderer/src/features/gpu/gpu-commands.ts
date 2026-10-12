import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { openSettings } from '../../stores/dialogs';
import { tryCommand } from '../../stores/toasts';

/**
 * The question asked before Caxri stops using hardware acceleration.
 *
 * This is the only click in the product that changes how every future launch draws, so the copy has to carry all three
 * consequences at once: it restarts now, it lasts past this session, and Settings takes it back. VS Code gates its one
 * comparable boot-flag write the same way: confirm, then write, then restart
 * (`services/localization/electron-browser/localeService.ts`), and never flips this particular flag for the user at
 * all. Exported so the wording is covered by a unit test rather than only by a screenshot; a function rather than a
 * constant so the copy follows the active language.
 */
export function turnOffHardwareAccelerationConfirm() {
    return {
        confirmLabel: translate('gpu.turnOffConfirm.confirmLabel'),
        message: translate('gpu.turnOffConfirm.message'),
        title: translate('gpu.turnOffConfirm.title'),
    };
}

/**
 * Asks, then restarts without hardware acceleration. Answering anything but the confirming button leaves the boot
 * configuration untouched and the window running, because the confirmation is resolved before the request is sent.
 */
export async function confirmTurnOffHardwareAcceleration(): Promise<void> {
    const isConfirmed = await caxri.window.showConfirm(turnOffHardwareAccelerationConfirm());
    if (!isConfirmed) return;
    await tryCommand(translate('gpu.restartFailed'), () => caxri.request('gpu.restartInSafeMode'));
}

/**
 * Opens Settings scrolled to the hardware acceleration row. Every notice about degraded drawing offers this route, so
 * the state is never something the user can reach only by already knowing where it lives.
 */
export function openHardwareAccelerationSettings(): void {
    openSettings('hardware-acceleration');
}
