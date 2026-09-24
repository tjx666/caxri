import { Buffer } from 'node:buffer';

import type { CommandExecutionContext, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

type TerminalSendParameters = Extract<ServerRequest, { method: 'terminal.send' }>['params'];

interface TerminalSendInput {
    invoke: () => Promise<unknown>;
    invokePairedDevice: () => Promise<unknown>;
    logger: Pick<StructuredLogger, 'write'>;
    parameters: TerminalSendParameters;
    principalKind: CommandExecutionContext['principal']['kind'];
}

/**
 * Paired devices are owner-controlled through their own narrower short-reply authority. The caller must route that
 * branch through `mobileAccess.invokeShortReply`, which rechecks pairing, Project scope, and the waiting Agent epoch.
 */
export async function invokeTerminalSend(input: TerminalSendInput): Promise<unknown> {
    let result: unknown;
    if (input.principalKind === 'paired-device') result = await input.invokePairedDevice();
    else {
        if (input.principalKind !== 'human-cli' && input.principalKind !== 'desktop')
            throw new CaxriError('FORBIDDEN', 'Terminal steer requires a human owner principal');
        result = await input.invoke();
    }
    input.logger.write('info', logEventCatalog.terminal.humanSteer, {
        fields: {
            terminalId: input.parameters.terminalId,
            byteLength: Buffer.byteLength(input.parameters.text, 'utf8'),
            enter: input.parameters.enter,
            principalKind: input.principalKind,
        },
    });
    return result;
}
