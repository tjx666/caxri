import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

export interface ShellIntegrationLaunch {
    args: string[];
    environment: NodeJS.ProcessEnv;
}

/**
 * Managed Agent startup needs a shell whose private startup files Caxri can control. Ordinary Shell Terminals still use
 * the configured platform shell; only Agent Terminals fall back to the platform's integrated system shell: zsh on
 * macOS, bash on Linux, where zsh is often not installed.
 */
export function managedAgentShellExecutable(
    executable: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (['bash', 'zsh'].includes(basename(executable))) return executable;
    return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

const ZSH_ENV = `typeset -g __caxri_user_zdotdir="\${CAXRI_USER_ZDOTDIR:-\${HOME:-}}"
typeset -g __caxri_integration_zdotdir="\${CAXRI_SHELL_INTEGRATION_DIR:-}"
if [[ -n "$__caxri_user_zdotdir" && "$__caxri_user_zdotdir" != "$__caxri_integration_zdotdir" && -r "$__caxri_user_zdotdir/.zshenv" ]]; then
  source "$__caxri_user_zdotdir/.zshenv"
fi
[[ -n "$__caxri_integration_zdotdir" ]] && ZDOTDIR="$__caxri_integration_zdotdir"
`;

const ZSH_PROFILE = `if [[ -n "$__caxri_user_zdotdir" && -r "$__caxri_user_zdotdir/.zprofile" ]]; then
  source "$__caxri_user_zdotdir/.zprofile"
fi
`;

const ZSH_PROMPT_HOOKS = String.raw`autoload -Uz add-zsh-hook 2>/dev/null
function __caxri_prompt_started() {
  local command_status=$?
  if (( ${'$'}{+__caxri_command_active} )); then
    printf '\e]133;D;%d\a' "$command_status"
    unset __caxri_command_active
  fi
  printf '\e]133;A\a'
}
function __caxri_command_started() {
  printf '\e]133;B\a\e]133;C\a'
  typeset -g __caxri_command_active=1
}
add-zsh-hook precmd __caxri_prompt_started
add-zsh-hook preexec __caxri_command_started
`;

const ZSH_RC = `if [[ -n "$__caxri_user_zdotdir" && -r "$__caxri_user_zdotdir/.zshrc" ]]; then
  source "$__caxri_user_zdotdir/.zshrc"
fi
${ZSH_PROMPT_HOOKS}`;

/**
 * A second Ctrl+C can arrive after the Agent restores terminal input but before user startup finishes. Consume only the
 * first such interrupt for managed returns; another interrupt can still cancel a stuck startup file. Never replace an
 * existing trap or remove one installed by user startup. The first prompt also repairs integration state if an
 * intentional subsequent interrupt skips .zlogin.
 */
const ZSH_STARTUP_RECOVERY = `${ZSH_PROMPT_HOOKS}
function __caxri_finish_startup() {
  if [[ -n "\${__caxri_startup_trap-}" && "\${functions[TRAPINT]-}" == "$__caxri_startup_trap" ]]; then
    unfunction TRAPINT
  fi
  unset __caxri_startup_trap
  [[ -n "$__caxri_user_zdotdir" ]] && ZDOTDIR="$__caxri_user_zdotdir"
  unset CAXRI_SHELL_INTEGRATION_DIR CAXRI_USER_ZDOTDIR
  add-zsh-hook -d precmd __caxri_finish_startup
  unfunction __caxri_finish_startup
  return 0
}
add-zsh-hook precmd __caxri_finish_startup
if [[ "\${__caxri_managed_agent_exited-}" == 1 && -z "$(trap)" ]]; then
  function TRAPINT() {
    unfunction TRAPINT
    return 0
  }
  typeset -g __caxri_startup_trap="$functions[TRAPINT]"
fi
unset __caxri_managed_agent_exited
`;

/**
 * Removes one-time launcher metadata before starting the child so an exited Agent returns to a credential-free
 * interactive shell instead of ending the PTY or leaking its token. zsh is still sourcing .zshenv while the Agent runs:
 * an interrupt reaching the waiting shell must not abort the rest of its startup. A local, non-ignoring trap consumes
 * that interrupt without making children inherit SIG_IGN or changing the eventual interactive shell.
 */
const MANAGED_AGENT_LAUNCHER = String.raw`function __caxri_launch_managed_agent() {
  if [[ -n "${'$'}{ZSH_VERSION-}" ]]; then
    setopt localoptions localtraps
    trap ':' INT
  fi
  local __caxri_agent_restore_xtrace=0
  case "$-" in
    *x*) __caxri_agent_restore_xtrace=1; set +x ;;
  esac
  local __caxri_agent_launcher_runtime="${'$'}{CAXRI_AGENT_LAUNCHER_RUNTIME-}"
  local __caxri_agent_launcher_entry="${'$'}{CAXRI_AGENT_LAUNCHER_ENTRY-}"
  local __caxri_agent_launcher_socket="${'$'}{CAXRI_AGENT_LAUNCHER_SOCKET-}"
  local __caxri_agent_launcher_id="${'$'}{CAXRI_AGENT_LAUNCHER_ID-}"
  local __caxri_agent_launcher_token="${'$'}{CAXRI_AGENT_LAUNCHER_TOKEN-}"
  unset CAXRI_AGENT_LAUNCHER_RUNTIME CAXRI_AGENT_LAUNCHER_ENTRY CAXRI_AGENT_LAUNCHER_SOCKET CAXRI_AGENT_LAUNCHER_ID CAXRI_AGENT_LAUNCHER_TOKEN

  if [[ -n "$__caxri_agent_launcher_runtime" && -n "$__caxri_agent_launcher_entry" && -n "$__caxri_agent_launcher_socket" && -n "$__caxri_agent_launcher_id" && -n "$__caxri_agent_launcher_token" ]]; then
    CAXRI_AGENT_LAUNCHER_TOKEN="$__caxri_agent_launcher_token" \
      "$__caxri_agent_launcher_runtime" "$__caxri_agent_launcher_entry" --managed-agent-launcher "$__caxri_agent_launcher_socket" "$__caxri_agent_launcher_id"
    if [[ -n "${'$'}{ZSH_VERSION-}" ]]; then
      typeset -g __caxri_managed_agent_exited=1
    fi
  fi

  unset __caxri_agent_launcher_runtime __caxri_agent_launcher_entry __caxri_agent_launcher_socket __caxri_agent_launcher_id __caxri_agent_launcher_token
  if [[ "$__caxri_agent_restore_xtrace" == 1 ]]; then set -x; fi
}
__caxri_launch_managed_agent
unset -f __caxri_launch_managed_agent
`;

const ZSH_ENV_WITH_MANAGED_AGENT = `${MANAGED_AGENT_LAUNCHER}
${ZSH_STARTUP_RECOVERY}
${ZSH_ENV}`;

const ZSH_LOGIN = `if [[ -n "$__caxri_user_zdotdir" && -r "$__caxri_user_zdotdir/.zlogin" ]]; then
  source "$__caxri_user_zdotdir/.zlogin"
fi
__caxri_finish_startup
`;

const BASH_RC = String.raw`${MANAGED_AGENT_LAUNCHER}
if [[ -r /etc/profile ]]; then source /etc/profile; fi
if [[ -r "${'$'}{HOME:-}/.bash_profile" ]]; then
  source "${'$'}{HOME:-}/.bash_profile"
elif [[ -r "${'$'}{HOME:-}/.bash_login" ]]; then
  source "${'$'}{HOME:-}/.bash_login"
elif [[ -r "${'$'}{HOME:-}/.profile" ]]; then
  source "${'$'}{HOME:-}/.profile"
fi

declare -a __caxri_original_prompt_commands
if [[ -n "${'$'}{PROMPT_COMMAND+x}" ]]; then
  __caxri_original_prompt_commands=("${'$'}{PROMPT_COMMAND[@]}")
fi
__caxri_prompt_ready=0
__caxri_command_active=0
__caxri_in_prompt=0
__caxri_pending_status=0

function __caxri_prompt_command() {
  local command_status="$1"
  __caxri_in_prompt=1
  if [[ "$__caxri_command_active" == 1 ]]; then
    printf '\e]133;D;%d\a' "$command_status"
  fi
  __caxri_command_active=0
  printf '\e]133;A\a'
  __caxri_prompt_ready=1
  if [[ -n "${'$'}{__caxri_original_prompt_commands[0]+x}" ]]; then
    local original_command
    (exit "$command_status")
    eval "${'$'}{__caxri_original_prompt_commands[0]}"
    for original_command in "${'$'}{__caxri_original_prompt_commands[@]:1}"; do
      eval "$original_command"
    done
  fi
  __caxri_in_prompt=0
}

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0=$'\e]133;B\a\e]133;C\a'"${'$'}{PS0-}"
elif [[ -z "$(trap -p DEBUG)" ]]; then
  function __caxri_command_started() {
    local command_status=$?
    if [[ "$BASH_COMMAND" == '__caxri_prompt_command '* ]]; then
      __caxri_pending_status="$command_status"
      return 0
    fi
    if [[ "$__caxri_prompt_ready" == 1 && "$__caxri_in_prompt" == 0 && "$__caxri_command_active" == 0 ]]; then
      printf '\e]133;B\a\e]133;C\a'
      __caxri_command_active=1
    fi
  }
  trap '__caxri_command_started' DEBUG
fi
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  unset PROMPT_COMMAND
  PROMPT_COMMAND='__caxri_prompt_command "$__caxri_pending_status"'
else
  unset PROMPT_COMMAND
  PROMPT_COMMAND='__caxri_prompt_command "$?"'
fi
unset CAXRI_SHELL_INTEGRATION_DIR CAXRI_USER_ZDOTDIR
`;

/**
 * Replaces only regular files beneath the private integration directory without following a user-controlled leaf
 * symlink left behind by an older or interrupted launch.
 */
async function writeOwnedScript(path: string, source: string): Promise<void> {
    const handle = await open(
        path,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        await handle.chmod(0o600);
        await handle.writeFile(source, 'utf8');
    } finally {
        await handle.close();
    }
}

/**
 * Writes Caxri-owned startup scripts and maps only allowlisted shell executables to them.
 */
export class ShellIntegrationService {
    static async create(userDataPath: string): Promise<ShellIntegrationService> {
        const directory = join(userDataPath, 'shell-integration');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error('Shell integration path must be a private directory');
        await chmod(directory, 0o700);
        await Promise.all(
            [
                ['.zshenv', ZSH_ENV_WITH_MANAGED_AGENT],
                ['.zprofile', ZSH_PROFILE],
                ['.zshrc', ZSH_RC],
                ['.zlogin', ZSH_LOGIN],
                ['bashrc', BASH_RC],
            ].map(async ([name, source]) => {
                const path = join(directory, name);
                await writeOwnedScript(path, source);
            }),
        );
        return new ShellIntegrationService(directory);
    }

    private constructor(private readonly directory: string) {}

    resolve(
        executable: string,
        environment: NodeJS.ProcessEnv,
    ): ShellIntegrationLaunch | undefined {
        const shell = basename(executable);
        if (shell === 'zsh')
            return {
                args: ['-l'],
                environment: {
                    ...environment,
                    CAXRI_SHELL_INTEGRATION_DIR: this.directory,
                    CAXRI_USER_ZDOTDIR: environment.ZDOTDIR ?? environment.HOME,
                    ZDOTDIR: this.directory,
                },
            };
        if (shell === 'bash')
            return {
                args: ['--init-file', join(this.directory, 'bashrc'), '-i'],
                environment: { ...environment },
            };
        return undefined;
    }
}

/**
 * Creates shell integration, or logs why it is unavailable so Terminals launch without it instead of failing startup.
 */
export async function createShellIntegration(
    userDataPath: string,
    logger: StructuredLogger,
): Promise<ShellIntegrationService | undefined> {
    try {
        return await ShellIntegrationService.create(userDataPath);
    } catch (error: unknown) {
        logger.write('warn', logEventCatalog.pty.shellIntegrationUnavailable, {
            fields: { error: error instanceof Error ? error.message : String(error) },
        });
        return undefined;
    }
}
