import { z } from 'zod';

import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

const tcpPortSchema = z.number().int().min(1).max(65_535);

/**
 * One TCP port a process of the Session is listening on, such as a dev server an Agent started. `processName` is the
 * executable name `lsof` reports (for example `node`), never the command line.
 */
const mobilePreviewTargetSchema = z.strictObject({
    port: tcpPortSchema,
    processName: z.string().min(1).max(64),
});

/**
 * `url` is a plain-HTTP address on the gateway interface the phone is already connected through. Its single-use token
 * is the only authority, so it is issued exclusively over the sealed channel; the first request trades it for a cookie
 * scoped to that preview listener.
 */
const mobilePreviewOpenResultSchema = z.strictObject({
    url: z.url({ protocol: /^http$/u }).max(2_048),
});

/**
 * Previews of a Session's local web servers on the phone; see `docs/mobile/preview.md`. Both are `control` only: the
 * preview proxies every HTTP method, so it can change the dev server's state like any browser on the computer.
 */
export const mobilePreviewMethods = {
    'mobile.preview.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ targets: z.array(mobilePreviewTargetSchema).max(32) }),
    },
    'mobile.preview.open': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema, port: tcpPortSchema }),
        result: mobilePreviewOpenResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Directories whose listening processes belong to a Session: its Workbench root plus every Terminal's launch `cwd` and
 * reported `agentCwd`, which covers a linked worktree outside the Project root.
 */
export const mobilePreviewInternalMethods = {
    'mobile.preview.rootsInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ sessionId: identifierSchema, principal: principalSchema }),
        result: z.strictObject({ roots: z.array(pathSchema).max(256) }),
    },
} as const satisfies Record<string, MethodSpec>;

export type MobilePreviewTarget = z.infer<typeof mobilePreviewTargetSchema>;
