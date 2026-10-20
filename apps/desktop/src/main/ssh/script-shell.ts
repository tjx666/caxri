import { randomBytes } from 'node:crypto';

import { shellQuote } from './shell-quote';

/**
 * Shared building blocks of the remote `sh` scripts in `scripts.ts`: input assertions that keep every embedded
 * value a hash, a relative path, or an integer, the per-script nonce, the common prologue, and the shell function
 * libraries several scripts splice in after it.
 */

const HEX_PATTERN = /^[0-9a-f]+$/u;
const RELATIVE_PATH_PATTERN = /^[\w.-]+(?:\/[\w.-]+)*$/u;

export function assertHex(value: string, label: string): string {
    if (!HEX_PATTERN.test(value)) throw new Error(`${label} must be lowercase hex`);
    return value;
}

export function assertRelativePath(value: string, label: string): string {
    if (!RELATIVE_PATH_PATTERN.test(value) || value.split('/').includes('..'))
        throw new Error(`${label} must be a relative path inside the artifact`);
    return value;
}

export function assertPositiveInteger(value: number, label: string): number {
    if (value < 0 || !Number.isSafeInteger(value))
        throw new Error(`${label} must be a non-negative integer`);
    return value;
}

export function nonce(): string {
    return randomBytes(8).toString('hex');
}

/**
 * Shared prologue: strict mode, private file modes, the remote root, the begin/end result printer, and SHA-256 helpers
 * that fall back to `shasum -a 256` where coreutils' `sha256sum` is absent.
 */
export function prologue(marker: string): string {
    return String.raw`set -eu
umask 077
CAXRI_ROOT="$HOME/.caxri-server"
CAXRI_BEGIN=${shellQuote(`__CAXRI_${marker}_BEGIN__`)}
CAXRI_END=${shellQuote(`__CAXRI_${marker}_END__`)}
caxri_result() {
    printf '%s\n' "$CAXRI_BEGIN"
    for caxri_line in "$@"; do printf '%s\n' "$caxri_line"; done
    printf '%s\n' "$CAXRI_END"
}
caxri_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}
caxri_sha256_check() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi
}
caxri_sleep() {
    sleep 0.2 2>/dev/null || sleep 1
}
`;
}

/**
 * `mkdir` is atomic on every filesystem, so it serves as the install lock. A lock whose recorded owner is gone is stale
 * (a killed install) and is removed; a lock without an owner file is only trusted for a few seconds, which covers the
 * window between `mkdir` and writing the pid.
 */
export const LOCK_FUNCTIONS = `CAXRI_LOCK="$CAXRI_ROOT/install.lock"
caxri_try_lock() {
    if mkdir "$CAXRI_LOCK" 2>/dev/null; then
        printf '%s\\n' "$$" > "$CAXRI_LOCK/pid"
        return 0
    fi
    caxri_owner=$(cat "$CAXRI_LOCK/pid" 2>/dev/null || true)
    if [ -n "$caxri_owner" ] && ! kill -0 "$caxri_owner" 2>/dev/null; then
        rm -rf "$CAXRI_LOCK"
    elif [ -z "$caxri_owner" ] && [ "\${caxri_lock_waited:-0}" -ge 25 ]; then
        rm -rf "$CAXRI_LOCK"
    fi
    return 1
}
caxri_lock() {
    caxri_lock_waited=0
    while ! caxri_try_lock; do
        caxri_lock_waited=$((caxri_lock_waited + 1))
        if [ "$caxri_lock_waited" -ge 600 ]; then return 1; fi
        caxri_sleep
    done
}
caxri_unlock() {
    rm -rf "$CAXRI_LOCK"
}
`;

/**
 * Reads the pid and process identity out of a one-line Server discovery JSON document without a JSON parser.
 */
export const DISCOVERY_FUNCTIONS = String.raw`caxri_json_pid() {
    sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1
}
caxri_json_identity() {
    sed -n 's/.*"processIdentity"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
caxri_process_build() {
    if [ -r "/proc/$1/cmdline" ]; then
        tr '\000' '\n' < "/proc/$1/cmdline" 2>/dev/null | sed -n 's|.*/\.caxri-server/builds/\([^/]*\)/.*|\1|p' | head -n 1
    fi
}
caxri_is_server_pid() {
    [ -n "$1" ] || return 1
    kill -0 "$1" 2>/dev/null || return 1
    if [ -r "/proc/$1/cmdline" ]; then
        tr '\000' '\n' < "/proc/$1/cmdline" 2>/dev/null | grep -q 'server-core' || return 1
    fi
    return 0
}
CAXRI_PROFILE="$CAXRI_ROOT/profile"
CAXRI_MANIFEST="$CAXRI_PROFILE/host/manifest.json"
CAXRI_CREDENTIAL="$CAXRI_PROFILE/host/desktop-credential.json"
`;
