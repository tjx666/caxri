import { Buffer } from 'node:buffer';
import type { Dir } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, opendir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { AgentEnvironment } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';

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
        let handle: FileHandle | undefined;
        try {
            handle = await open(
                join(base, entry.name, '.cwd'),
                constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            const stats = await handle.stat();
            if (!stats.isFile() || stats.size > 16_384) continue;
            const buffer = Buffer.alloc(16_385);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (
                bytesRead <= 16_384 &&
                buffer.subarray(0, bytesRead).toString('utf8').trim() === cwd
            )
                return join(base, entry.name);
        } catch {
            // Missing or unsafe identity markers cannot authorize a transcript directory.
        } finally {
            await handle?.close();
        }
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
