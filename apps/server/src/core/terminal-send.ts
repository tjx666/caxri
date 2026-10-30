import { Buffer } from 'node:buffer';

import type { CommandExecutionContext, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

type TerminalSendParameters = Extract<ServerRequest, { method: 'terminal.send' }>['params'];

interface TerminalSendInput {
    invoke: () => Promise<unknown>;
    logger: Pick<StructuredLogger, 'write'>;
    parameters: TerminalSendParameters;
    principalKind: CommandExecutionContext['principal']['kind'];
}

/**
 * Logs human-owner Terminal steering. A paired device is pointed at its own scoped input method instead.
 */
export async function invokeTerminalSend(input: TerminalSendInput): Promise<unknown> {
    if (input.principalKind === 'paired-device')
        throw new CaxriError('FORBIDDEN', 'Use mobile.agent.submit for mobile input');
    if (input.principalKind !== 'human-cli' && input.principalKind !== 'desktop')
        throw new CaxriError('FORBIDDEN', 'Terminal steer requires a human owner principal');
    const result = await input.invoke();
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
