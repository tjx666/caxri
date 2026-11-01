import type { DeviceAction, DeviceActionOutcome } from '@caxri/protocol';
import { deviceActionFailureSchema, fitDeviceExecStream } from '@caxri/protocol';

/**
 * What the native Termux module answers for one command: its output, or why it did not run.
 */
export type TermuxRunResult =
    | {
          status: 'exited';
          exitCode: number;
          stdout: string;
          stderr: string;
          /**
           * Termux itself cut the output to fit an Android binder transaction.
           */
          termuxTruncated: boolean;
      }
    | { status: 'failed'; reason: string; message?: string | null };

export interface DeviceActionPorts {
    /**
     * The phone's "Termux commands" setting; off by default.
     */
    isTermuxEnabled: () => Promise<boolean>;
    /**
     * `null` where the platform cannot run Termux commands (iOS, or a build without the native module).
     */
    runTermux:
        | ((argv: string[], cwd: string | undefined, timeoutMs: number) => Promise<TermuxRunResult>)
        | null;
    /**
     * Opens the link the way a tap on it in Caxri would. Rejects when the system refuses it.
     */
    openUrl: (url: string) => Promise<void>;
}

const failed = (
    reason: Extract<DeviceActionOutcome, { status: 'failed' }>['reason'],
    message?: string | null,
): DeviceActionOutcome => ({
    status: 'failed',
    reason,
    ...(message && { message: message.slice(0, 1_024) }),
});

const termuxOutcome = (result: TermuxRunResult): DeviceActionOutcome => {
    if (result.status === 'failed') {
        const reason = deviceActionFailureSchema.safeParse(result.reason);
        return failed(reason.success ? reason.data : 'termux-error', result.message);
    }
    const stdout = fitDeviceExecStream(result.stdout);
    const stderr = fitDeviceExecStream(result.stderr);
    return {
        status: 'exited',
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: result.termuxTruncated || stdout.truncated || stderr.truncated,
    };
};

/**
 * Carries out one action Desktop pushed and returns the outcome to report back. Never throws: every failure becomes a
 * closed reason the CLI caller can read.
 */
export const runDeviceAction = async (
    action: DeviceAction,
    ports: DeviceActionPorts,
): Promise<DeviceActionOutcome> => {
    if (action.kind === 'openUrl') {
        try {
            await ports.openUrl(action.url);
            return { status: 'opened' };
        } catch {
            return failed('open-failed');
        }
    }
    if (!ports.runTermux) return failed('unsupported');
    if (!(await ports.isTermuxEnabled())) return failed('disabled');
    try {
        return termuxOutcome(await ports.runTermux(action.argv, action.cwd, action.timeoutMs));
    } catch (error) {
        return failed('termux-error', error instanceof Error ? error.message : undefined);
    }
};
