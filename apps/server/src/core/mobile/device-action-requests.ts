import type {
    CommandExecutionContext,
    DeviceActionFailure,
    DeviceActionOutcome,
    MethodResult,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { MobileDeviceRegistry } from './device-registry';
import type { MobileGateway } from './gateway';

type MobileDeviceActionRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.deviceAction.targets'
            | 'mobile.deviceAction.openUrl'
            | 'mobile.deviceAction.exec'
            | 'mobile.deviceAction.complete';
    }
>;

/**
 * Turns a phone's failure into the error a CLI caller sees. `details.reason` keeps the closed reason so an Agent can
 * branch on it without reading the message.
 */
const failureError = (reason: DeviceActionFailure, message?: string): CaxriError => {
    const details = { reason };
    switch (reason) {
        case 'disabled':
            return new CaxriError(
                'FORBIDDEN',
                'Termux commands are turned off on the phone (Settings › Termux commands)',
                details,
            );
        case 'unsupported':
            return new CaxriError('UNAVAILABLE', 'This phone cannot run Termux commands', details);
        case 'termux-missing':
            return new CaxriError(
                'UNAVAILABLE',
                'Termux is not installed on the phone; install it from F-Droid or GitHub',
                details,
            );
        case 'permission-denied':
            return new CaxriError(
                'FORBIDDEN',
                'Caxri may not run commands in Termux; allow it in the phone’s Termux commands setting',
                details,
            );
        case 'termux-error':
            return new CaxriError(
                'IO',
                message ? `Termux refused the command: ${message}` : 'Termux refused the command',
                details,
            );
        case 'timeout':
            return new CaxriError('TIMEOUT', 'The command did not finish in time', details);
        case 'open-failed':
            return new CaxriError('IO', 'The phone could not open the link', details);
    }
};

const expectStatus = <S extends DeviceActionOutcome['status']>(
    outcome: DeviceActionOutcome,
    status: S,
): Extract<DeviceActionOutcome, { status: S }> => {
    if (outcome.status === 'failed') throw failureError(outcome.reason, outcome.message);
    if (outcome.status !== status)
        throw new CaxriError('INTERNAL', 'The phone answered with the wrong outcome');
    return outcome as Extract<DeviceActionOutcome, { status: S }>;
};

/**
 * `mobile.deviceAction.*`: the CLI-facing commands that push an action to a connected phone, and the phone's answer.
 */
export async function invokeMobileDeviceActionRequest(
    request: MobileDeviceActionRequest,
    context: CommandExecutionContext,
    registry: Pick<MobileDeviceRegistry, 'list'>,
    gateway: Pick<MobileGateway, 'deviceActions'>,
    authorizePaired: (method: string) => void,
): Promise<unknown> {
    switch (request.method) {
        case 'mobile.deviceAction.targets': {
            const online = gateway.deviceActions.onlineDeviceIds();
            return {
                devices: registry
                    .list()
                    .filter((device) => !device.revokedAt)
                    .map((device) => ({
                        deviceId: device.deviceId,
                        displayName: device.displayName,
                        platform: device.platform,
                        online: online.has(device.deviceId),
                    })),
            } satisfies MethodResult<'mobile.deviceAction.targets'>;
        }
        case 'mobile.deviceAction.openUrl': {
            const { deviceId, outcome } = await gateway.deviceActions.request(
                request.params.deviceId,
                { kind: 'openUrl', url: request.params.url },
            );
            expectStatus(outcome, 'opened');
            return { deviceId } satisfies MethodResult<'mobile.deviceAction.openUrl'>;
        }
        case 'mobile.deviceAction.exec': {
            const { deviceId: target, argv, cwd, timeoutMs } = request.params;
            const { deviceId, outcome } = await gateway.deviceActions.request(target, {
                kind: 'termuxExec',
                argv,
                timeoutMs,
                ...(cwd !== undefined && { cwd }),
            });
            const exited = expectStatus(outcome, 'exited');
            return {
                deviceId,
                exitCode: exited.exitCode,
                stdout: exited.stdout,
                stderr: exited.stderr,
                truncated: exited.truncated,
            } satisfies MethodResult<'mobile.deviceAction.exec'>;
        }
        case 'mobile.deviceAction.complete': {
            authorizePaired(request.method);
            if (context.principal.kind !== 'paired-device')
                throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
            gateway.deviceActions.complete(
                context.principal.deviceId,
                request.params.actionId,
                request.params.outcome,
            );
            return null;
        }
    }
}
