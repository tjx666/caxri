import { join } from 'node:path';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';

import type { AskpassHandler } from './askpass';
import { SshHostServerSupervisor } from './server-supervisor';
import type { SshHostSeedConfig, SshHostStateUpdate } from './server-supervisor-options';
import { defaultSshControlDirectory } from './ssh-connection';

/**
 * Environment variable naming an `ssh -F` config file. Tests and acceptance point it at a disposable lab so they never
 * read or write the user's `~/.ssh/config`, keys, or `known_hosts`.
 */
export const SSH_CONFIG_ENVIRONMENT_KEY = 'CAXRI_SSH_CONFIG';

export interface SshHostSupervisorFactoryOptions {
    destination: string;
    electronExecutable: string;
    /**
     * Defaults to `process.env`; read for {@link SSH_CONFIG_ENVIRONMENT_KEY}.
     */
    environment?: NodeJS.ProcessEnv;
    hooks: {
        askpass: AskpassHandler;
        update(patch: SshHostStateUpdate): void;
    };
    inspect?: boolean;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Desktop-owned directory for SSH Host data, such as the cached Node runtime for hosts that cannot download it.
     * Sockets do not live here: a profile path under `~/Library/Application Support` is too long for `sun_path`, so the
     * ControlMaster and askpass sockets use the short `/tmp/caxri-ssh-<uid>` root.
     */
    privateDirectory: string;
    remoteLayersRoot: string;
    seedConfig?: () => Promise<SshHostSeedConfig>;
}

/**
 * Composition-root factory for one SSH Host window's supervisor.
 */
export function createSshHostSupervisor(
    options: SshHostSupervisorFactoryOptions,
): SshHostServerSupervisor {
    const environment = options.environment ?? process.env;
    const configFile = environment[SSH_CONFIG_ENVIRONMENT_KEY];
    return new SshHostServerSupervisor({
        askpass: options.hooks.askpass,
        ...(configFile !== undefined && configFile !== '' && { configFile }),
        destination: options.destination,
        electronExecutable: options.electronExecutable,
        ...(options.inspect !== undefined && { inspect: options.inspect }),
        logger: options.logger,
        onState: (update) => options.hooks.update(update),
        privateDirectory: defaultSshControlDirectory(),
        remoteLayersRoot: options.remoteLayersRoot,
        runtimeCacheDirectory: join(options.privateDirectory, 'runtimes'),
        ...(options.seedConfig && { seedConfig: options.seedConfig }),
    });
}
