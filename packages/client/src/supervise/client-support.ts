import { Buffer } from 'node:buffer';

import type {
    DesktopOperation,
    DesktopTargetPayload,
    ServerDesktopCredential,
} from '@caxri/protocol';
import type { RawData } from 'ws';

/**
 * Default timeout for connecting to Server Core and for each `ServerClient` request.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A single in-flight `ServerClient` request awaiting its reply or timeout.
 */
export interface PendingRequest {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer?: NodeJS.Timeout;
}

export type ServerClientCredential =
    | { kind: 'operator' }
    | { kind: 'delegation-client'; clientId: string; generation: number; token: string }
    | {
          kind: 'agent';
          hostId: string;
          endpointId: string;
          generation: number;
          token: string;
      }
    | {
          kind: 'desktop';
          desktopId: string;
          credential: ServerDesktopCredential;
          handleCommand(
              operation: DesktopOperation,
              consumeTarget: () => Promise<DesktopTargetPayload>,
          ): Promise<unknown>;
      };

/**
 * Decodes a raw `ws` control-frame payload the same way regardless of whether the runtime delivered it as a Buffer, an
 * ArrayBuffer, or a Buffer array.
 */
export function controlMessageText(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.concat(data).toString('utf8');
}
