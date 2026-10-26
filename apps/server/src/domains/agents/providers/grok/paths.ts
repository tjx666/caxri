import type { Dir } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentEnvironment } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';

const MAX_GROK_CWD_BYTES = 16_384;

/**
 * The trimmed cwd recorded in a Grok session directory's `.cwd` marker, or `undefined` when the marker is missing,
 * oversized, not a regular file, a symlink, or empty. Such a marker cannot name or authorize a transcript directory.
 */
export async function readGrokCwdMarker(directory: string): Promise<string | undefined> {
    try {
        const cwd = (
            await readBoundedRegularFileText(join(directory, '.cwd'), MAX_GROK_CWD_BYTES, {
                symlinks: 'nofollow',
            })
        ).trim();
        return cwd || undefined;
    } catch {
        return undefined;
    }
}

export function grokHome(environment: AgentEnvironment): string {
    const configured = environment.variables.GROK_HOME;
    return configured
        ? isAbsolute(configured)
            ? configured
            : join(environment.homeDirectory, configured)
        : join(environment.homeDirectory, '.grok');
}

/**
 * Grok Build percent-encodes the canonical cwd into one path segment, including `!'()*` which `encodeURIComponent`
 * leaves unescaped. Launch, resume, and title probes must share this encoding so a special-character cwd cannot resolve
 * to two different directories.
 *
 * @see https://github.com/xai-org/grok-build/blob/37949780/crates/codegen/xai-grok-config/src/paths.rs
 */
export function encodeGrokCwdDirname(cwd: string): string {
    return encodeURIComponent(cwd).replaceAll(
        /[!'()*]/gu,
        (value) => `%${value.codePointAt(0)!.toString(16).toUpperCase()}`,
    );
}

/**
 * Grok percent-encodes short cwd names and records long hashed names in a bounded .cwd metadata file. Read only that
 * identity marker; never discover a task by scanning transcript content or guessing the latest session. This is the
 * single session-directory derivation: callers canonicalize the cwd themselves.
 *
 * @see https://github.com/xai-org/grok-build/blob/37949780/crates/codegen/xai-grok-config/src/paths.rs
 */
export async function grokProjectRoot(
    cwd: string,
    environment: AgentEnvironment,
    signal?: AbortSignal,
): Promise<string | undefined> {
    signal?.throwIfAborted();
    const base = join(grokHome(environment), 'sessions');
    const encoded = encodeGrokCwdDirname(cwd);
    if (encoded.length <= 255) return join(base, encoded);
    let directory: Dir;
    try {
        directory = await opendir(base);
    } catch {
        return;
    }
    let count = 0;
    for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++count > 512) return;
        if (!entry.isDirectory()) continue;
        if ((await readGrokCwdMarker(join(base, entry.name))) === cwd)
            return join(base, entry.name);
    }
    return;
}

export async function locateGrokTranscript(
    context: { agentSessionId: string; cwd: string },
    environment: AgentEnvironment,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    if (!isOpaqueAgentSessionId(context.agentSessionId)) return;
    const root = await grokProjectRoot(context.cwd, environment, signal);
    if (!root) return;
    const sessionRoot = join(root, context.agentSessionId);
    return {
        anchorRoot: join(grokHome(environment), 'sessions'),
        baseRoot: root,
        root: sessionRoot,
        path: join(sessionRoot, 'updates.jsonl'),
    };
}
