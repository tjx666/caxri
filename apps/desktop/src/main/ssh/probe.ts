/**
 * What the probe script (`probeScript`) reported about an SSH Host, parsed from its `key=value` lines.
 */
export interface SshHostProbe {
    /**
     * `x64`/`arm64` for supported machines, otherwise `uname -m` verbatim.
     */
    architecture: string;
    builds: ReadonlySet<string>;
    configPresent: boolean;
    /**
     * The Linux os-release `ID` (`ubuntu`, `debian`, ...), lower-case; empty elsewhere, when the file is missing, or
     * when the value is not a plain identifier. It only picks the Host mark's system logo.
     */
    distribution: string;
    /**
     * Empty when no glibc was found (for example musl or macOS).
     */
    glibc: string;
    home: string;
    /**
     * `sw_vers -productVersion` on macOS, such as `15.1`; empty elsewhere or when `sw_vers` failed.
     */
    macos: string;
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

const DISTRIBUTION_PATTERN = /^[a-z0-9._-]{1,64}$/;

function parseDistribution(value: string): string {
    const id = value.trim().toLowerCase();
    return DISTRIBUTION_PATTERN.test(id) ? id : '';
}

export function parseProbe(result: Map<string, string>): SshHostProbe {
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
        distribution: parseDistribution(result.get('distro') ?? ''),
        glibc: result.get('glibc') ?? '',
        home: result.get('home') ?? '',
        macos: result.get('macos') ?? '',
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
