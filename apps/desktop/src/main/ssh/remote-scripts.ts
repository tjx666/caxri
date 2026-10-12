import {
    assertHex,
    assertPositiveInteger,
    assertRelativePath,
    DISCOVERY_FUNCTIONS,
    LOCK_FUNCTIONS,
    nonce,
    prologue,
} from './remote-script-shell';
import { shellQuote } from './shell-quote';

/**
 * POSIX `sh` scripts Desktop runs on an SSH Host through `SshConnection.exec`. Every value is embedded with
 * `shellQuote`, every path is rooted at `$HOME/.caxri-server`, and every result is printed as `key=value` lines between
 * two marker lines carrying a per-script nonce, so a login banner, a `.bashrc` that echoes, or `motd` noise on stdout
 * can never be mistaken for a result.
 *
 * Remote layout (ADR 0014):
 *
 * - `runtimes/<sha256>/node`: Node runtime cache addressed by the binary's hash.
 * - `builds/<buildId>/`: one application layer; `runtime/bin/node` is a hard link into the cache, `.caxri-runtime`
 *   records which runtime it uses, and `.caxri-complete` marks a verified install.
 * - `profile/`: the remote Server profile (`CAXRI_USER_DATA_PATH`).
 * - `install.lock/`: `mkdir`-based install lock holding the owner's pid.
 */

export interface RemoteScript {
    marker: string;
    script: string;
}

const SEEDABLE_CONFIG_FILES = ['settings.jsonc', 'keybindings.jsonc', 'theme.json'] as const;
export type SeedableConfigFile = (typeof SEEDABLE_CONFIG_FILES)[number];

export interface ProbeInput {
    /**
     * Candidate build ids, one per architecture this Desktop carries, because the architecture is not known before the
     * probe returns.
     */
    buildIds: readonly string[];
    runtimeSha256s: readonly string[];
}

/**
 * Reports the platform, tool availability, whether the wanted build and runtime are installed, and the running Server.
 */
export function probeScript(input: ProbeInput): RemoteScript {
    const marker = nonce();
    const script = String.raw`${prologue(marker)}${DISCOVERY_FUNCTIONS}
caxri_os=$(uname -s 2>/dev/null || echo unknown)
caxri_arch=$(uname -m 2>/dev/null || echo unknown)
caxri_glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc[[:space:]]*//p' || true)
if [ -z "$caxri_glibc" ]; then
    caxri_glibc=$(ldd --version 2>&1 | head -n 1 | grep -i -e glibc -e 'gnu libc' | sed -n 's/.*[[:space:]]\([0-9][0-9]*\.[0-9][0-9]*\)[[:space:]]*$/\1/p' || true)
fi
caxri_host=$(uname -n 2>/dev/null || echo unknown)
set -- "os=$caxri_os" "arch=$caxri_arch" "glibc=$caxri_glibc" "hostname=$caxri_host" "home=$HOME"
for caxri_tool in curl wget tar gzip base64 sha256sum shasum setsid nohup xz; do
    if command -v "$caxri_tool" >/dev/null 2>&1; then set -- "$@" "tool.$caxri_tool=1"; else set -- "$@" "tool.$caxri_tool=0"; fi
done
for caxri_build in ${input.buildIds.map((id) => shellQuote(assertHex(id, 'buildId'))).join(' ')}; do
    if [ -f "$CAXRI_ROOT/builds/$caxri_build/.caxri-complete" ]; then set -- "$@" "build.$caxri_build=1"; fi
done
for caxri_runtime in ${input.runtimeSha256s.map((sha) => shellQuote(assertHex(sha, 'runtimeSha256'))).join(' ')}; do
    if [ -x "$CAXRI_ROOT/runtimes/$caxri_runtime/node" ]; then set -- "$@" "runtime.$caxri_runtime=1"; fi
done
if [ -d "$CAXRI_PROFILE/config" ]; then set -- "$@" config=1; else set -- "$@" config=0; fi
caxri_pid=$(caxri_json_pid "$CAXRI_MANIFEST")
if caxri_is_server_pid "$caxri_pid"; then
    set -- "$@" "server.pid=$caxri_pid" "server.build=$(caxri_process_build "$caxri_pid")"
fi
caxri_result "$@"
`;
    return { marker, script };
}

export interface InstallAppInput {
    appSha256: string;
    buildId: string;
    runtimePath: string;
    runtimeSha256: string;
}

/**
 * Installs one application layer from a gzip tarball on stdin. The tarball hash, every file against `SHA256SUMS`, and
 * the absence of unlisted files are all verified before the build is renamed into place, so a partial or tampered
 * upload never becomes a build. Exit codes: 3 runtime missing, 4 archive checksum, 5 extract, 6 file checksum, 7 lock.
 */
export function installAppScript(input: InstallAppInput): RemoteScript {
    const marker = nonce();
    const script = String.raw`${prologue(marker)}${LOCK_FUNCTIONS}
caxri_build=${shellQuote(assertHex(input.buildId, 'buildId'))}
caxri_app_sha=${shellQuote(assertHex(input.appSha256, 'appSha256'))}
caxri_runtime_sha=${shellQuote(assertHex(input.runtimeSha256, 'runtimeSha256'))}
caxri_runtime_path=${shellQuote(assertRelativePath(input.runtimePath, 'runtimePath'))}
caxri_builds="$CAXRI_ROOT/builds"
caxri_final="$caxri_builds/$caxri_build"
caxri_runtime="$CAXRI_ROOT/runtimes/$caxri_runtime_sha/node"
mkdir -p "$caxri_builds"
if [ -f "$caxri_final/.caxri-complete" ]; then
    cat >/dev/null
    caxri_result status=present
    exit 0
fi
if [ ! -x "$caxri_runtime" ]; then
    cat >/dev/null
    caxri_result status=runtime-missing
    exit 3
fi
if ! caxri_lock; then
    cat >/dev/null
    caxri_result status=locked
    exit 7
fi
caxri_tmp="$caxri_builds/.tmp-$caxri_build-${nonce()}"
trap 'rm -rf "$caxri_tmp" "$caxri_tmp.tgz"; caxri_unlock' EXIT
mkdir "$caxri_tmp"
cat > "$caxri_tmp.tgz"
if [ -f "$caxri_final/.caxri-complete" ]; then
    caxri_result status=present
    exit 0
fi
if [ "$(caxri_sha256 "$caxri_tmp.tgz")" != "$caxri_app_sha" ]; then
    caxri_result status=archive-checksum
    exit 4
fi
if ! tar -xzf "$caxri_tmp.tgz" -C "$caxri_tmp"; then
    caxri_result status=extract
    exit 5
fi
rm -f "$caxri_tmp.tgz"
if [ ! -f "$caxri_tmp/SHA256SUMS" ] || ! (cd "$caxri_tmp" && caxri_sha256_check SHA256SUMS >/dev/null 2>&1); then
    caxri_result status=checksum
    exit 6
fi
caxri_listed=$(grep -c . "$caxri_tmp/SHA256SUMS" || true)
caxri_present=$(cd "$caxri_tmp" && find . -type f ! -path ./SHA256SUMS | wc -l | tr -d ' ')
if [ "$caxri_listed" != "$caxri_present" ]; then
    caxri_result status=checksum
    exit 6
fi
mkdir -p "$(dirname "$caxri_tmp/$caxri_runtime_path")"
ln "$caxri_runtime" "$caxri_tmp/$caxri_runtime_path" 2>/dev/null || cp "$caxri_runtime" "$caxri_tmp/$caxri_runtime_path"
chmod 755 "$caxri_tmp/$caxri_runtime_path"
printf '%s\n' "$caxri_runtime_sha" > "$caxri_tmp/.caxri-runtime"
: > "$caxri_tmp/.caxri-complete"
rm -rf "$caxri_final"
mv "$caxri_tmp" "$caxri_final"
caxri_result status=installed
`;
    return { marker, script };
}

export interface RuntimeSourceInput {
    /**
     * Archive member path of the `node` binary, such as `node-v<version>-linux-arm64/bin/node`.
     */
    member: string;
    /**
     * SHA-256 of the extracted `node` binary; the cache key.
     */
    runtimeSha256: string;
    /**
     * SHA-256 of the downloaded archive.
     */
    sha256: string;
    url: string;
}

/**
 * Downloads the pinned Node archive on the SSH Host with `curl` or `wget`, verifies the archive and the extracted
 * binary, and moves it into the runtime cache. Exit codes: 20 download, 21 no downloader, 22 archive checksum, 23
 * extract, 24 binary checksum. Any failure makes Desktop upload the runtime itself.
 *
 * Both downloaders are bounded so a firewalled host falls back to the upload quickly: an unreachable nodejs.org costs
 * at most two 10 s (curl) or 15 s (wget) connect attempts, and a stalled transfer aborts instead of holding the attach
 * until the 10-minute script timeout. `wget` needs an explicit `-t 2` because its default is 20 tries.
 */
export function fetchRuntimeScript(input: RuntimeSourceInput): RemoteScript {
    if (!/^https:\/\/[^\s'"]+$/u.test(input.url)) throw new Error('Runtime URL must be https');
    const marker = nonce();
    const script = `${prologue(marker)}
caxri_url=${shellQuote(input.url)}
caxri_archive_sha=${shellQuote(assertHex(input.sha256, 'sha256'))}
caxri_member=${shellQuote(assertRelativePath(input.member, 'member'))}
caxri_node_sha=${shellQuote(assertHex(input.runtimeSha256, 'runtimeSha256'))}
caxri_target_dir="$CAXRI_ROOT/runtimes/$caxri_node_sha"
if [ -x "$caxri_target_dir/node" ]; then
    caxri_result status=present
    exit 0
fi
mkdir -p "$CAXRI_ROOT/runtimes"
caxri_tmp="$CAXRI_ROOT/runtimes/.tmp-${nonce()}"
trap 'rm -rf "$caxri_tmp"' EXIT
mkdir "$caxri_tmp"
if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL --connect-timeout 10 --retry 1 --speed-limit 1024 --speed-time 30 -o "$caxri_tmp/archive" "$caxri_url"; then
        caxri_result status=download
        exit 20
    fi
elif command -v wget >/dev/null 2>&1; then
    if ! wget -q -T 15 -t 2 -O "$caxri_tmp/archive" "$caxri_url"; then
        caxri_result status=download
        exit 20
    fi
else
    caxri_result status=no-downloader
    exit 21
fi
if [ "$(caxri_sha256 "$caxri_tmp/archive")" != "$caxri_archive_sha" ]; then
    caxri_result status=archive-checksum
    exit 22
fi
case "$caxri_url" in
    *.tar.xz) caxri_tar_flags=-xJf ;;
    *) caxri_tar_flags=-xzf ;;
esac
if ! tar "$caxri_tar_flags" "$caxri_tmp/archive" -C "$caxri_tmp" "$caxri_member" 2>/dev/null; then
    caxri_result status=extract
    exit 23
fi
if [ "$(caxri_sha256 "$caxri_tmp/$caxri_member")" != "$caxri_node_sha" ]; then
    caxri_result status=checksum
    exit 24
fi
chmod 755 "$caxri_tmp/$caxri_member"
mkdir -p "$caxri_target_dir"
mv "$caxri_tmp/$caxri_member" "$caxri_target_dir/node"
caxri_result status=installed
`;
    return { marker, script };
}

/**
 * Receives the gzip-compressed `node` binary on stdin (the SSH Host could not download it) and caches it after
 * verifying its hash. Exit codes: 23 decompress, 24 checksum.
 */
export function uploadRuntimeScript(input: { runtimeSha256: string }): RemoteScript {
    const marker = nonce();
    const script = `${prologue(marker)}
caxri_node_sha=${shellQuote(assertHex(input.runtimeSha256, 'runtimeSha256'))}
caxri_target_dir="$CAXRI_ROOT/runtimes/$caxri_node_sha"
if [ -x "$caxri_target_dir/node" ]; then
    cat >/dev/null
    caxri_result status=present
    exit 0
fi
mkdir -p "$CAXRI_ROOT/runtimes"
caxri_tmp="$CAXRI_ROOT/runtimes/.tmp-${nonce()}"
trap 'rm -rf "$caxri_tmp"' EXIT
mkdir "$caxri_tmp"
if ! gzip -dc > "$caxri_tmp/node"; then
    caxri_result status=extract
    exit 23
fi
if [ "$(caxri_sha256 "$caxri_tmp/node")" != "$caxri_node_sha" ]; then
    caxri_result status=checksum
    exit 24
fi
chmod 755 "$caxri_tmp/node"
mkdir -p "$caxri_target_dir"
mv "$caxri_tmp/node" "$caxri_target_dir/node"
caxri_result status=installed
`;
    return { marker, script };
}

export interface LaunchInput {
    buildId: string;
    /**
     * Opt-in inspector for remote debugging; off by default because it opens a debugger port on the SSH Host.
     */
    inspect?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    /**
     * How long to wait for discovery files after starting a Server.
     */
    readySeconds?: number;
}

/**
 * Adopts the running Server or starts `builds/<buildId>` detached, then prints its discovery documents base64-encoded.
 * A running Server from another build is adopted rather than replaced: the profile lock would refuse a second Server,
 * and Desktop's build-fingerprint check replaces a stale one through `host.stop` before launching again.
 *
 * The Server is started with `setsid` and `nohup` and all three standard streams redirected, so it leaves the SSH
 * session's process group, survives the channel closing, and does not keep the channel open. Exit codes: 30 missing
 * build, 31 the Server exited, 32 timed out.
 */
export function launchScript(input: LaunchInput): RemoteScript {
    const marker = nonce();
    const readyIterations = assertPositiveInteger(input.readySeconds ?? 20, 'readySeconds') * 5;
    const script = String.raw`${prologue(marker)}${DISCOVERY_FUNCTIONS}
caxri_build=${shellQuote(assertHex(input.buildId, 'buildId'))}
caxri_build_dir="$CAXRI_ROOT/builds/$caxri_build"
caxri_ready() {
    [ -f "$CAXRI_MANIFEST" ] && [ -f "$CAXRI_CREDENTIAL" ] || return 1
    caxri_pid=$(caxri_json_pid "$CAXRI_MANIFEST")
    caxri_is_server_pid "$caxri_pid" || return 1
    [ "$(caxri_json_identity "$CAXRI_MANIFEST")" = "$(caxri_json_identity "$CAXRI_CREDENTIAL")" ] || return 1
}
caxri_emit() {
    caxri_result "outcome=$1" "pid=$caxri_pid" "server.build=$(caxri_process_build "$caxri_pid")" \
        "manifest=$(base64 < "$CAXRI_MANIFEST" | tr -d '\n')" \
        "credential=$(base64 < "$CAXRI_CREDENTIAL" | tr -d '\n')"
}
if caxri_ready; then
    caxri_emit adopted
    exit 0
fi
if [ ! -x "$caxri_build_dir/runtime/caxri-server" ]; then
    caxri_result outcome=missing-build
    exit 30
fi
mkdir -p "$CAXRI_PROFILE/logs" "$CAXRI_ROOT/agent-hooks"
chmod 700 "$CAXRI_ROOT" "$CAXRI_PROFILE"
caxri_log="$CAXRI_PROFILE/logs/server-stdio.log"
if [ -f "$caxri_log" ] && [ "$(wc -c < "$caxri_log" | tr -d ' ')" -gt 5242880 ]; then
    mv -f "$caxri_log" "$caxri_log.1"
fi
unset SSH_CONNECTION SSH_CLIENT SSH_TTY SSH_AUTH_SOCK SSH_ORIGINAL_COMMAND
CAXRI_USER_DATA_PATH="$CAXRI_PROFILE"
CAXRI_AGENT_HOOKS_PATH="$CAXRI_ROOT/agent-hooks"
CAXRI_INSPECT=${input.inspect === true ? '1' : '0'}
CAXRI_LOG_LEVEL=${shellQuote(input.logLevel ?? 'info')}
export CAXRI_USER_DATA_PATH CAXRI_AGENT_HOOKS_PATH CAXRI_INSPECT CAXRI_LOG_LEVEL
if [ -f "$caxri_build_dir/cli/caxri.cjs" ]; then
    CAXRI_CLI_PATH="$caxri_build_dir/cli/caxri.cjs"
    export CAXRI_CLI_PATH
fi
cd "$HOME"
if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$caxri_build_dir/runtime/caxri-server" < /dev/null >> "$caxri_log" 2>&1 &
else
    nohup "$caxri_build_dir/runtime/caxri-server" < /dev/null >> "$caxri_log" 2>&1 &
fi
caxri_started=$!
caxri_iteration=0
caxri_gone=0
while [ "$caxri_iteration" -lt ${readyIterations} ]; do
    if caxri_ready; then
        caxri_emit started
        exit 0
    fi
    # A started process that exits may have lost the profile lock to a Server another Desktop started at the same
    # moment, so its exit only fails the launch once no Server has appeared for a few more seconds.
    if ! kill -0 "$caxri_started" 2>/dev/null; then
        caxri_gone=$((caxri_gone + 1))
        if [ "$caxri_gone" -ge 25 ]; then
            tail -n 5 "$caxri_log" >&2 2>/dev/null || true
            caxri_result outcome=exited
            exit 31
        fi
    fi
    caxri_iteration=$((caxri_iteration + 1))
    caxri_sleep
done
tail -n 5 "$caxri_log" >&2 2>/dev/null || true
caxri_result outcome=timeout
exit 32
`;
    return { marker, script };
}

/**
 * Waits until a remote pid is gone, for Desktop's stale-build replacement and Stop Remote Server.
 */
export function stopWaitScript(input: { pid: number; timeoutSeconds: number }): RemoteScript {
    const marker = nonce();
    const pid = assertPositiveInteger(input.pid, 'pid');
    const limit = assertPositiveInteger(input.timeoutSeconds, 'timeoutSeconds') * 5;
    const script = `${prologue(marker)}
caxri_iteration=0
while kill -0 ${pid} 2>/dev/null; do
    caxri_iteration=$((caxri_iteration + 1))
    if [ "$caxri_iteration" -ge ${limit} ]; then
        caxri_result state=alive
        exit 0
    fi
    caxri_sleep
done
caxri_result state=exited
`;
    return { marker, script };
}

/**
 * Removes builds other than the current one and the most recently installed previous one, never a build a running
 * process was started from, then runtimes no remaining build references. It skips entirely while an install holds the
 * lock rather than waiting for it.
 */
export function gcScript(input: { buildId: string; runtimeSha256: string }): RemoteScript {
    const marker = nonce();
    const script = String.raw`${prologue(marker)}${LOCK_FUNCTIONS}
caxri_current=${shellQuote(assertHex(input.buildId, 'buildId'))}
caxri_keep_runtime=${shellQuote(assertHex(input.runtimeSha256, 'runtimeSha256'))}
caxri_builds="$CAXRI_ROOT/builds"
if [ ! -d "$caxri_builds" ]; then
    caxri_result removedBuilds=0 removedRuntimes=0
    exit 0
fi
caxri_lock_waited=0
if ! caxri_try_lock; then
    caxri_result status=locked
    exit 0
fi
trap 'caxri_unlock' EXIT
caxri_running=$(for caxri_cmdline in /proc/[0-9]*/cmdline; do
    if [ -r "$caxri_cmdline" ]; then tr '\000' '\n' < "$caxri_cmdline" 2>/dev/null || true; fi
done | sed -n 's|.*/\.caxri-server/builds/\([^/]*\)/.*|\1|p' | sort -u)
caxri_previous=
caxri_removed_builds=0
for caxri_name in $(ls -1t "$caxri_builds"); do
    [ -d "$caxri_builds/$caxri_name" ] || continue
    [ "$caxri_name" = "$caxri_current" ] && continue
    if [ -z "$caxri_previous" ] && [ -f "$caxri_builds/$caxri_name/.caxri-complete" ]; then
        caxri_previous=$caxri_name
        continue
    fi
    if printf '%s\n' "$caxri_running" | grep -qx "$caxri_name"; then continue; fi
    rm -rf "$caxri_builds/$caxri_name"
    caxri_removed_builds=$((caxri_removed_builds + 1))
done
find "$caxri_builds" -maxdepth 1 -name '.tmp-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
caxri_referenced=$(cat "$caxri_builds"/*/.caxri-runtime 2>/dev/null || true)
caxri_removed_runtimes=0
for caxri_dir in "$CAXRI_ROOT/runtimes"/*; do
    [ -d "$caxri_dir" ] || continue
    caxri_sha=$(basename "$caxri_dir")
    [ "$caxri_sha" = "$caxri_keep_runtime" ] && continue
    if printf '%s\n' "$caxri_referenced" | grep -qx "$caxri_sha"; then continue; fi
    rm -rf "$caxri_dir"
    caxri_removed_runtimes=$((caxri_removed_runtimes + 1))
done
caxri_result "removedBuilds=$caxri_removed_builds" "removedRuntimes=$caxri_removed_runtimes"
`;
    return { marker, script };
}

/**
 * Writes one Desktop config file from stdin into the remote profile only when the file is absent. The final step is a
 * hard link, which fails instead of overwriting when a file appeared meanwhile, so a user's remote settings are never
 * replaced.
 */
export function seedConfigScript(input: { file: SeedableConfigFile }): RemoteScript {
    if (!SEEDABLE_CONFIG_FILES.includes(input.file)) throw new Error('Unknown config file');
    const marker = nonce();
    const script = `${prologue(marker)}
caxri_dir="$CAXRI_ROOT/profile/config"
caxri_target="$caxri_dir/"${shellQuote(input.file)}
mkdir -p "$caxri_dir"
if [ -e "$caxri_target" ]; then
    cat >/dev/null
    caxri_result status=present
    exit 0
fi
caxri_tmp="$caxri_dir/.seed-${nonce()}"
trap 'rm -f "$caxri_tmp"' EXIT
cat > "$caxri_tmp"
if ln "$caxri_tmp" "$caxri_target" 2>/dev/null; then
    caxri_result status=written
else
    caxri_result status=present
fi
`;
    return { marker, script };
}

/**
 * Extracts the `key=value` lines between a script's marker lines. Returns `undefined` when the block is absent, which
 * means the script died before reporting (for example `set -e` on a full disk).
 */
export function parseRemoteResult(stdout: string, marker: string): Map<string, string> | undefined {
    const lines = stdout.split(/\r?\n/u);
    const begin = lines.lastIndexOf(`__CAXRI_${marker}_BEGIN__`);
    if (begin === -1) return undefined;
    const end = lines.indexOf(`__CAXRI_${marker}_END__`, begin + 1);
    if (end === -1) return undefined;
    const result = new Map<string, string>();
    const body = lines.slice(begin + 1, end);
    for (const line of body) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        if (!result.has(key)) result.set(key, line.slice(separator + 1));
    }
    return result;
}

export interface RemoteProbe {
    /**
     * `x64`/`arm64` for supported machines, otherwise `uname -m` verbatim.
     */
    architecture: string;
    builds: ReadonlySet<string>;
    configPresent: boolean;
    /**
     * Empty when no glibc was found (for example musl).
     */
    glibc: string;
    home: string;
    hostname: string;
    os: string;
    runtimes: ReadonlySet<string>;
    server?: { build?: string; pid: number };
    tools: Readonly<Record<string, boolean>>;
}

const ARCHITECTURE_ALIASES: Readonly<Record<string, string>> = {
    aarch64: 'arm64',
    amd64: 'x64',
    arm64: 'arm64',
    x86_64: 'x64',
};

export function parseProbe(result: Map<string, string>): RemoteProbe {
    const tools: Record<string, boolean> = {};
    const builds = new Set<string>();
    const runtimes = new Set<string>();
    for (const [key, value] of result) {
        const isSet = value === '1';
        if (key.startsWith('tool.')) tools[key.slice(5)] = isSet;
        else if (isSet && key.startsWith('build.')) builds.add(key.slice(6));
        else if (isSet && key.startsWith('runtime.')) runtimes.add(key.slice(8));
    }
    const rawArchitecture = result.get('arch') ?? '';
    const pid = Number(result.get('server.pid'));
    const serverBuild = result.get('server.build');
    return {
        architecture: ARCHITECTURE_ALIASES[rawArchitecture] ?? rawArchitecture,
        builds,
        configPresent: result.get('config') === '1',
        glibc: result.get('glibc') ?? '',
        home: result.get('home') ?? '',
        hostname: (result.get('hostname') ?? '').slice(0, 255),
        os: result.get('os') ?? '',
        runtimes,
        ...(pid > 0 &&
            Number.isSafeInteger(pid) && {
                server: { pid, ...(serverBuild && { build: serverBuild }) },
            }),
        tools,
    };
}

/**
 * Compares dotted numeric versions such as `2.28` and `2.36`; non-numeric parts compare as zero.
 */
export function compareVersions(left: string, right: string): number {
    const toNumbers = (version: string): number[] =>
        version
            .split('.')
            .map((part) => (/^\d+/u.test(part) ? Math.trunc(Number(/^\d+/u.exec(part)?.[0])) : 0));
    const a = toNumbers(left);
    const b = toNumbers(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}
