import type {
    AgentLaunchSettings,
    AgentProvider,
    TerminalFailureReason,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentLaunch,
    assertE2EShellLaunch,
    logEventCatalog,
    readE2EAgentPolicy,
} from '@caxri/system';

// Server providers use the public domain barrel by architecture contract.
// oxlint-disable-next-line react-doctor/no-barrel-import
import { agentProviders } from '../agents';
import { serverProcessEnvironment } from '../executables';
import { assertTerminalWorkingDirectory, resolveTerminalExecutable } from './launch';
import type {
    TerminalManagerOptions,
    TerminalStartOptions,
    TerminalWorkingDirectoryIdentity,
} from './manager-types';
import { terminalEnvironment } from './terminal-environment';

export interface ResolvedTerminalLaunch {
    args: string[];
    executable: string;
    launch?: AgentLaunchSettings;
}

export interface TerminalLaunchPlan extends ResolvedTerminalLaunch {
    environment: NodeJS.ProcessEnv;
}

export type TerminalLaunchPlanResult<T> =
    { ok: true; value: T } | { ok: false; error: unknown; failureReason: TerminalFailureReason };

export interface TerminalLaunchPlannerOptions {
    agentEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    agentLaunchSettings?: (provider: AgentProvider) => AgentLaunchSettings;
    lifecycleEnvironment?: TerminalManagerOptions['lifecycleEnvironment'];
    logger: StructuredLogger;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    shellIntegration?: TerminalManagerOptions['shellIntegration'];
}

/**
 * Produces the serializable launch input consumed by the Terminal execution owner. Splitting resolve from prepare keeps
 * the existing restore-grid wait between executable discovery and working-directory/environment validation.
 */
export class TerminalLaunchPlanner {
    private readonly agentEnvironment: () => Promise<NodeJS.ProcessEnv>;

    constructor(private readonly options: TerminalLaunchPlannerOptions) {
        this.agentEnvironment = options.agentEnvironment ?? serverProcessEnvironment;
    }

    async resolve(
        record: TerminalRecord,
        start?: TerminalStartOptions,
    ): Promise<TerminalLaunchPlanResult<ResolvedTerminalLaunch>> {
        try {
            const e2eAgentPolicy = readE2EAgentPolicy();
            const launch =
                record.kind === 'shell'
                    ? undefined
                    : (this.options.agentLaunchSettings?.(record.kind) ?? {
                          executable: agentProviderCatalog[record.kind].executableName,
                          args: [],
                      });
            if (record.kind === 'shell') assertE2EShellLaunch(e2eAgentPolicy);
            else
                assertE2EAgentLaunch(
                    e2eAgentPolicy,
                    record.kind,
                    launch!,
                    start?.resumeAgentSessionId,
                );
            try {
                const executable = await resolveTerminalExecutable(
                    record.kind,
                    launch,
                    this.options.resolveExecutable,
                );
                const arguments_ = record.kind === 'shell' ? ['-l'] : [...launch!.args];
                if (record.kind !== 'shell' && start?.resumeAgentSessionId) {
                    arguments_.push(
                        ...agentProviders[record.kind].resumeArguments(start.resumeAgentSessionId),
                    );
                }
                return { ok: true, value: { args: arguments_, executable, launch } };
            } catch (error) {
                return { ok: false, error, failureReason: 'executable_not_found' };
            }
        } catch (error) {
            return { ok: false, error, failureReason: 'spawn_failed' };
        }
    }

    async prepare(
        record: TerminalRecord,
        resolved: ResolvedTerminalLaunch,
        expectedWorkingDirectory?: TerminalWorkingDirectoryIdentity,
    ): Promise<TerminalLaunchPlanResult<TerminalLaunchPlan>> {
        try {
            await assertTerminalWorkingDirectory(record.cwd, expectedWorkingDirectory);
        } catch (error) {
            return { ok: false, error, failureReason: 'working_directory_unavailable' };
        }
        try {
            let arguments_ = resolved.args;
            let environment = {
                ...(record.kind === 'shell'
                    ? terminalEnvironment()
                    : {
                          ...(await this.agentEnvironment()),
                          TERM: 'xterm-256color',
                          COLORTERM: 'truecolor',
                      }),
                ...(await this.options.lifecycleEnvironment?.(record, resolved.launch)),
            };
            if (record.kind === 'shell') {
                try {
                    const integrated = this.options.shellIntegration?.(
                        resolved.executable,
                        environment,
                    );
                    if (integrated) {
                        arguments_ = integrated.args;
                        environment = integrated.environment;
                    }
                } catch (error) {
                    /**
                     * Shell integration is optional decoration metadata; startup retains the ordinary login-shell path
                     * if its resolver becomes unavailable.
                     */
                    this.options.logger.write(
                        'warn',
                        logEventCatalog.pty.shellIntegrationUnavailable,
                        {
                            fields: { error: errorMessage(error, 'unknown') },
                        },
                    );
                }
            }
            return { ok: true, value: { ...resolved, args: arguments_, environment } };
        } catch (error) {
            return { ok: false, error, failureReason: 'spawn_failed' };
        }
    }
}
