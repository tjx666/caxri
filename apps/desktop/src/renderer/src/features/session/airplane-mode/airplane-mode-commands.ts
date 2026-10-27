import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { tryCommand } from '../../../stores/toasts';

/**
 * These commands never write their reply into the query cache: only the ordered `session.airplaneModeChanged` events
 * do. A reply can arrive after a later event (a resume with nothing to relaunch turns `off` within milliseconds), and
 * writing it would put the dialog back into a phase the Server already left.
 */
export async function enterAirplaneMode(): Promise<void> {
    await tryCommand(translate('session.airplaneMode.enterFailed'), () =>
        caxri.request('session.enterAirplaneMode', {}),
    );
}

export async function skipAirplaneModeCompaction(): Promise<void> {
    await tryCommand(translate('session.airplaneMode.enterFailed'), () =>
        caxri.request('session.skipAirplaneModeCompaction', {}),
    );
}

export async function exitAirplaneMode(sessionIds: readonly string[]): Promise<void> {
    await tryCommand(translate('session.airplaneMode.exitFailed'), () =>
        caxri.request('session.exitAirplaneMode', { sessionIds: [...sessionIds] }),
    );
}

/**
 * The Sessions a resume relaunches: every parked one the user did not untick, in the parked order.
 */
export function pickedAirplaneModeSessions(
    parkedSessionIds: readonly string[],
    uncheckedSessionIds: ReadonlySet<string>,
): string[] {
    return parkedSessionIds.filter((sessionId) => !uncheckedSessionIds.has(sessionId));
}
