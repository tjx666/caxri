import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';

export const MANAGED_AGENT_LAUNCHER_FLAG = '--managed-agent-launcher' as const;
export const MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES = 16 * 1024;
export const MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES = 2 * 1024 * 1024;

export const managedAgentLauncherEnvironmentNames = [
    'CAXRI_AGENT_LAUNCHER_RUNTIME',
    'CAXRI_AGENT_LAUNCHER_ENTRY',
    'CAXRI_AGENT_LAUNCHER_SOCKET',
    'CAXRI_AGENT_LAUNCHER_ID',
    'CAXRI_AGENT_LAUNCHER_TOKEN',
] as const;

export interface ManagedAgentLauncherEnvironment {
    CAXRI_AGENT_LAUNCHER_RUNTIME: string;
    CAXRI_AGENT_LAUNCHER_ENTRY: string;
    CAXRI_AGENT_LAUNCHER_SOCKET: string;
    CAXRI_AGENT_LAUNCHER_ID: string;
    CAXRI_AGENT_LAUNCHER_TOKEN: string;
}

export interface ManagedAgentLaunchPlan {
    executable: string;
    args: string[];
    environment: Record<string, string>;
    cwd: string;
}

export type ManagedAgentLauncherSignal = 'SIGINT' | 'SIGHUP';

export type ManagedAgentLauncherEvent =
    | {
          type: 'started';
          terminalId: string;
          launchId: string;
          processId: number;
      }
    | {
          type: 'exited';
          terminalId: string;
          launchId: string;
          exitCode: number | null;
          signal: NodeJS.Signals | null;
      };

export interface ManagedAgentLauncherExit {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

export type ManagedAgentLauncherClientMessage =
    | { type: 'claim'; launchId: string; token: string }
    | { type: 'started'; processId: number }
    | { type: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
    | { type: 'drained' };

export type ManagedAgentLauncherServerMessage =
    | { type: 'signal'; signal: ManagedAgentLauncherSignal }
    | { type: 'cancel' }
    | { type: 'exitAck' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => key in value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        !value.includes('\0')
    );
}

function isSignal(value: unknown): value is NodeJS.Signals {
    return typeof value === 'string' && /^SIG[A-Z0-9]+$/.test(value) && value.length <= 32;
}

export function validateManagedAgentLaunchPlan(value: unknown): ManagedAgentLaunchPlan {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ['executable', 'args', 'environment', 'cwd']) ||
        !isBoundedString(value.executable, 4_096) ||
        !isAbsolute(value.executable) ||
        !isBoundedString(value.cwd, 4_096) ||
        !isAbsolute(value.cwd) ||
        !Array.isArray(value.args) ||
        value.args.length > 256 ||
        value.args.some(
            (argument) =>
                !(
                    typeof argument === 'string' &&
                    argument.length <= 16_384 &&
                    !argument.includes('\0')
                ),
        ) ||
        !isRecord(value.environment)
    ) {
        throw new Error('Invalid managed Agent launch plan');
    }

    const environmentEntries = Object.entries(value.environment);
    if (
        environmentEntries.length > 512 ||
        environmentEntries.some(
            ([name, environmentValue]) =>
                name.length === 0 ||
                name.length > 256 ||
                name.includes('=') ||
                name.includes('\0') ||
                name.startsWith('CAXRI_AGENT_LAUNCHER_') ||
                typeof environmentValue !== 'string' ||
                environmentValue.length > 64 * 1024 ||
                environmentValue.includes('\0'),
        )
    ) {
        throw new Error('Invalid managed Agent launch plan');
    }

    const plan = {
        executable: value.executable,
        args: value.args.map(String),
        environment: Object.fromEntries(environmentEntries) as Record<string, string>,
        cwd: value.cwd,
    };
    encodeJsonLine(plan, MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES);
    return plan;
}

export function parseManagedAgentLauncherClientMessage(
    value: unknown,
): ManagedAgentLauncherClientMessage {
    if (!isRecord(value) || typeof value.type !== 'string')
        throw new Error('Invalid managed Agent launcher message');
    if (value.type === 'drained' && hasExactKeys(value, ['type'])) return { type: 'drained' };
    if (
        value.type === 'claim' &&
        hasExactKeys(value, ['type', 'launchId', 'token']) &&
        isBoundedString(value.launchId, 256) &&
        isBoundedString(value.token, 256)
    ) {
        return { type: 'claim', launchId: value.launchId, token: value.token };
    }
    if (
        value.type === 'started' &&
        hasExactKeys(value, ['type', 'processId']) &&
        typeof value.processId === 'number' &&
        Number.isSafeInteger(value.processId) &&
        value.processId > 0
    ) {
        return { type: 'started', processId: value.processId };
    }
    if (
        value.type === 'exited' &&
        hasExactKeys(value, ['type', 'exitCode', 'signal']) &&
        (value.exitCode === null ||
            (typeof value.exitCode === 'number' &&
                Number.isSafeInteger(value.exitCode) &&
                value.exitCode >= 0 &&
                value.exitCode <= 255)) &&
        (value.signal === null || isSignal(value.signal)) &&
        (value.exitCode !== null || value.signal !== null)
    ) {
        return {
            type: 'exited',
            exitCode: value.exitCode,
            signal: value.signal,
        };
    }
    throw new Error('Invalid managed Agent launcher message');
}

export function parseManagedAgentLauncherServerMessage(
    value: unknown,
): ManagedAgentLauncherServerMessage {
    if (!isRecord(value) || typeof value.type !== 'string')
        throw new Error('Invalid managed Agent launcher control');
    if (value.type === 'cancel' && hasExactKeys(value, ['type'])) return { type: 'cancel' };
    if (value.type === 'exitAck' && hasExactKeys(value, ['type'])) return { type: 'exitAck' };
    if (
        value.type === 'signal' &&
        hasExactKeys(value, ['type', 'signal']) &&
        (value.signal === 'SIGINT' || value.signal === 'SIGHUP')
    ) {
        return { type: 'signal', signal: value.signal };
    }
    throw new Error('Invalid managed Agent launcher control');
}

export function encodeJsonLine(value: unknown, maxBytes: number): string {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, 'utf8') > maxBytes)
        throw new Error('Managed Agent launcher message exceeds its byte limit');
    return line;
}

/**
 * Decodes newline-delimited JSON while bounding both complete lines and an unterminated tail. A peer cannot retain an
 * unbounded partial JSON value in the long-lived Terminal Host or launcher process.
 */
export class BoundedJsonLineDecoder {
    private source = '';

    constructor(private maxBytes: number) {}

    setMaxBytes(maxBytes: number): void {
        this.maxBytes = maxBytes;
        if (Buffer.byteLength(this.source, 'utf8') > maxBytes)
            throw new Error('Managed Agent launcher message exceeds its byte limit');
    }

    push(chunk: string): Array<{ value: unknown; byteLength: number }> {
        this.source += chunk;
        const values: Array<{ value: unknown; byteLength: number }> = [];
        let newlineIndex = this.source.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.source.slice(0, newlineIndex);
            this.source = this.source.slice(newlineIndex + 1);
            const byteLength = Buffer.byteLength(line, 'utf8') + 1;
            if (byteLength > this.maxBytes)
                throw new Error('Managed Agent launcher message exceeds its byte limit');
            if (line.length === 0) throw new Error('Managed Agent launcher message is empty');
            try {
                values.push({ value: JSON.parse(line), byteLength });
            } catch {
                throw new Error('Managed Agent launcher message is not valid JSON');
            }
            newlineIndex = this.source.indexOf('\n');
        }
        if (Buffer.byteLength(this.source, 'utf8') > this.maxBytes)
            throw new Error('Managed Agent launcher message exceeds its byte limit');
        return values;
    }

    finish(): void {
        if (this.source.length > 0)
            throw new Error('Managed Agent launcher message ended before a newline');
    }
}
