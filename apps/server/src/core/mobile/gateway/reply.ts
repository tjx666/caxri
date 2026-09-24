import { Buffer } from 'node:buffer';

import { MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES } from '@caxri/mobile-transport';
import type { CommandReplyEnvelope } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    requestIdFromEnvelope,
    toWireError,
} from '@caxri/protocol';

export function forbiddenMobileReply(raw: unknown): CommandReplyEnvelope {
    return {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id: requestIdFromEnvelope(raw),
        ok: false,
        error: toWireError(new CaxriError('FORBIDDEN', 'Method is unavailable to paired devices')),
    };
}

export function boundedMobileReply(
    raw: unknown,
    reply: CommandReplyEnvelope,
): CommandReplyEnvelope {
    if (
        Buffer.byteLength(JSON.stringify({ type: 'reply', reply }), 'utf8') <=
        MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES
    )
        return reply;
    return {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id: requestIdFromEnvelope(raw),
        ok: false,
        error: toWireError(new CaxriError('CAPACITY', 'Mobile reply exceeds the frame limit')),
    };
}
