import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { mobileDeviceIdSchema } from './device-role.js';

/**
 * Bounds one Termux command's wait on both sides: the phone hands Termux this deadline and Server Core stops waiting a
 * little after it, so a phone that never answers cannot hold a CLI forever. The default matches the CLI's `--timeout`
 * default, which becomes this value for `caxri device exec`.
 */
export const DEVICE_EXEC_DEFAULT_TIMEOUT_MS = 15_000;
export const DEVICE_EXEC_MAX_TIMEOUT_MS = 10 * 60_000;
/**
 * The UTF-8 bytes each output stream may take once JSON-encoded. Both streams together stay well under one sealed
 * Mobile frame (`MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES`), whatever characters the command printed.
 */
export const DEVICE_EXEC_STREAM_MAX_JSON_BYTES = 20_000;

const deviceActionIdSchema = z.string().regex(/^action_[0-9a-f]{32}$/u);
const deviceExecArgumentSchema = z.string().max(4_096);
/**
 * The executable and its arguments, with no shell in between. A bare executable name resolves on Termux's `PATH`; `sh
 * -c '…'` runs a shell line.
 */
const deviceExecArgvSchema = z.array(deviceExecArgumentSchema).min(1).max(64);
/**
 * Working directory inside Termux; Termux's home directory when omitted.
 */
const deviceExecCwdSchema = z.string().min(1).max(1_024);

/**
 * What a phone is asked to do. `openUrl` follows the phone's own link rule (web pages in the in-app browser, any other
 * scheme in the app the system assigns); `termuxExec` runs one command through Termux's `RUN_COMMAND` service in the
 * background, so it needs the Android setting "Termux commands" turned on.
 */
const deviceActionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('openUrl'), url: z.url().max(2_048) }),
    z.strictObject({
        kind: z.literal('termuxExec'),
        argv: deviceExecArgvSchema,
        cwd: deviceExecCwdSchema.optional(),
        timeoutMs: z.number().int().min(1_000).max(DEVICE_EXEC_MAX_TIMEOUT_MS),
    }),
]);

/**
 * Why a phone did not carry out an action. A closed set, so a CLI caller can branch on it and logs can count it.
 */
export const deviceActionFailureSchema = z.enum([
    /**
     * The phone's "Termux commands" setting is off.
     */
    'disabled',
    /**
     * The platform cannot run the action at all (Termux commands on iOS).
     */
    'unsupported',
    'termux-missing',
    /**
     * Android has not granted Caxri Termux's `RUN_COMMAND` permission.
     */
    'permission-denied',
    /**
     * Termux refused or failed to start the command, for example with `allow-external-apps` unset; `message` carries
     * Termux's own explanation.
     */
    'termux-error',
    'timeout',
    'open-failed',
]);

export const deviceActionOutcomeSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('opened') }),
    z.strictObject({
        status: z.literal('exited'),
        exitCode: z.number().int(),
        stdout: z.string().max(DEVICE_EXEC_STREAM_MAX_JSON_BYTES),
        stderr: z.string().max(DEVICE_EXEC_STREAM_MAX_JSON_BYTES),
        /**
         * Whether either stream was cut to fit `DEVICE_EXEC_STREAM_MAX_JSON_BYTES`.
         */
        truncated: z.boolean(),
    }),
    z.strictObject({
        status: z.literal('failed'),
        reason: deviceActionFailureSchema,
        message: z.string().max(1_024).optional(),
    }),
]);

/**
 * The `deviceAction.requested` event body a phone receives on its `deviceActions` subscription.
 */
export const deviceActionRequestSchema = z.strictObject({
    actionId: deviceActionIdSchema,
    action: deviceActionSchema,
});

const deviceTargetParametersSchema = z.strictObject({
    deviceId: mobileDeviceIdSchema.optional(),
});

const deviceTargetSchema = z.strictObject({
    deviceId: mobileDeviceIdSchema,
    displayName: z.string().trim().min(1).max(100),
    platform: z.enum(['android', 'ios']),
    /**
     * Whether the phone is connected and listening for actions right now.
     */
    online: z.boolean(),
});

/**
 * Commands that ask a paired phone to act, and the phone's report back. A CLI or an Agent targets the one connected
 * phone (or names `deviceId` when several are), Server Core pushes the action over that phone's `deviceActions`
 * subscription, and the phone answers with `mobile.deviceAction.complete`. Nothing is queued: an offline phone fails
 * the request at once. See `docs/mobile/device-actions.md`.
 */
export const mobileDeviceActionMethods = {
    'mobile.deviceAction.targets': {
        ...commandPolicy('server', 'read', ['devices.control']),
        params: z.strictObject({}).default({}),
        result: z.strictObject({ devices: z.array(deviceTargetSchema).max(128) }),
    },
    'mobile.deviceAction.openUrl': {
        ...commandPolicy('server', 'control', ['devices.control']),
        params: deviceTargetParametersSchema.extend({ url: z.url().max(2_048) }),
        result: z.strictObject({ deviceId: mobileDeviceIdSchema }),
    },
    'mobile.deviceAction.exec': {
        ...commandPolicy('server', 'control', ['devices.control']),
        params: deviceTargetParametersSchema.extend({
            argv: deviceExecArgvSchema,
            cwd: deviceExecCwdSchema.optional(),
            timeoutMs: z
                .number()
                .int()
                .min(1_000)
                .max(DEVICE_EXEC_MAX_TIMEOUT_MS)
                .default(DEVICE_EXEC_DEFAULT_TIMEOUT_MS),
        }),
        result: z.strictObject({
            deviceId: mobileDeviceIdSchema,
            exitCode: z.number().int(),
            stdout: z.string(),
            stderr: z.string(),
            truncated: z.boolean(),
        }),
    },
    /**
     * The phone's answer to one pushed action. Every role may answer, since the action runs on the phone itself and
     * reads no Desktop data.
     */
    'mobile.deviceAction.complete': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        params: z.strictObject({
            actionId: deviceActionIdSchema,
            outcome: deviceActionOutcomeSchema,
        }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * UTF-8 bytes of `value` once JSON-encoded, without `TextEncoder`, so the phone and Server measure it the same way.
 */
const jsonUtf8Bytes = (value: string): number => {
    let bytes = 0;
    for (const character of JSON.stringify(value)) {
        const point = character.codePointAt(0) ?? 0;
        bytes += point < 0x80 ? 1 : point < 0x8_00 ? 2 : point < 0x1_00_00 ? 3 : 4;
    }
    return bytes;
};

/**
 * Keeps the start of one output stream within `DEVICE_EXEC_STREAM_MAX_JSON_BYTES`, cutting on a code point boundary.
 */
export const fitDeviceExecStream = (value: string): { text: string; truncated: boolean } => {
    if (jsonUtf8Bytes(value) <= DEVICE_EXEC_STREAM_MAX_JSON_BYTES)
        return { text: value, truncated: false };
    const points = [...value];
    let low = 0;
    let high = points.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (jsonUtf8Bytes(points.slice(0, middle).join('')) <= DEVICE_EXEC_STREAM_MAX_JSON_BYTES)
            low = middle;
        else high = middle - 1;
    }
    return { text: points.slice(0, low).join(''), truncated: true };
};

export type DeviceAction = z.infer<typeof deviceActionSchema>;
export type DeviceActionFailure = z.infer<typeof deviceActionFailureSchema>;
export type DeviceActionOutcome = z.infer<typeof deviceActionOutcomeSchema>;
export type DeviceActionRequest = z.infer<typeof deviceActionRequestSchema>;
