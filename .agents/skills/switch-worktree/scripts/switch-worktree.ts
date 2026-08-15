#!/usr/bin/env bun

import process from 'node:process';

import { acquireDesktopLease, releaseDesktopLease } from './desktop-lease';
import { CommandError, runInherited } from './process';
import {
    createWorktree,
    developmentWorktree,
    doctorWorktree,
    installWorktreeDependencies,
    listWorktreeStatus,
    removeWorktree,
    switchWorktree,
} from './worktree';

const USAGE = `Usage: switch-worktree <command> [options]

Commands:
  create <branch> [--base <ref>]       Create an isolated checkout and run ni
  switch <branch|path>                 Resolve or create a checkout for a local branch
  list                                 Inspect every associated checkout
  doctor [branch|path]                 Diagnose one checkout (default: current)
  dev                                  Start Caxri with this checkout's isolated profile
  remove <branch|path> [--clean-profile]
                                       Safely remove a checkout and preserve its branch
  desktop --label <name> -- <command>  Hold the repository-wide desktop lease

Options:
  --json                               Emit stable JSON for command results
  --help                               Show this message`;

interface ParsedArguments {
    base?: string;
    cleanProfile: boolean;
    command?: string;
    json: boolean;
    label?: string;
    operands: string[];
    trailing: string[];
}

/**
 * Apply one parsed token to `result`, returning the index of the last token consumed. `--base` and `--label` consume
 * the following token as their value, advancing the index by one.
 */
function applyToken(
    value: string,
    regular: string[],
    index: number,
    result: ParsedArguments,
): number {
    switch (value) {
        case '--json': {
            result.json = true;
            return index;
        }
        case '--clean-profile': {
            result.cleanProfile = true;
            return index;
        }
        case '--base':
        case '--label': {
            const nextIndex = index + 1;
            const option = regular[nextIndex];
            if (!option || option.startsWith('--')) {
                throw new CommandError(`${value} requires a value`, 2);
            }
            if (value === '--base') result.base = option;
            else result.label = option;
            return nextIndex;
        }
        case '--help':
        case '-h': {
            throw new CommandError(USAGE, 0);
        }
        default: {
            if (value.startsWith('-')) {
                throw new CommandError(`Unknown option: ${value}\n\n${USAGE}`, 2);
            }
            result.operands.push(value);
            return index;
        }
    }
}

function parseArguments(argv: string[]): ParsedArguments {
    const separator = argv.indexOf('--');
    const regular = separator === -1 ? argv : argv.slice(0, separator);
    const result: ParsedArguments = {
        cleanProfile: false,
        command: regular.shift(),
        json: false,
        operands: [],
        trailing: separator === -1 ? [] : argv.slice(separator + 1),
    };
    for (let index = 0; index < regular.length; index += 1) {
        index = applyToken(regular[index], regular, index, result);
    }
    return result;
}

function oneOperand(arguments_: ParsedArguments, isOptional = false): string | undefined {
    if (arguments_.operands.length > 1 || (!isOptional && arguments_.operands.length !== 1)) {
        throw new CommandError('Expected exactly one branch or path', 2);
    }
    return arguments_.operands[0];
}

function print(value: unknown, isJson: boolean): void {
    if (isJson) console.log(JSON.stringify(value, null, 2));
    else if (typeof value === 'string') console.log(value);
    else console.log(JSON.stringify(value, null, 2));
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-worker-isolation.test.ts
export function desktopCommandEnvironment(
    environment: NodeJS.ProcessEnv,
    coordinatorToken: string,
): NodeJS.ProcessEnv {
    return { ...environment, CAXRI_DESKTOP_COORDINATOR_TOKEN: coordinatorToken };
}

async function runDesktop(arguments_: ParsedArguments): Promise<void> {
    if (!arguments_.label) throw new CommandError('desktop requires --label <name>', 2);
    if (arguments_.trailing.length === 0)
        throw new CommandError('desktop requires -- <command>', 2);
    const lease = await acquireDesktopLease(process.cwd(), arguments_.label);
    if (arguments_.json) {
        print(
            {
                event: 'desktop-acquired',
                lease: {
                    acquiredAt: lease.acquiredAt,
                    label: lease.label,
                    pid: lease.pid,
                    worktreeId: lease.worktreeId,
                    worktreePath: lease.worktreePath,
                },
            },
            true,
        );
    }
    try {
        const exitCode = await runInherited(arguments_.trailing[0], arguments_.trailing.slice(1), {
            cwd: process.cwd(),
            env: desktopCommandEnvironment(process.env, lease.token),
            stdoutToStderr: arguments_.json,
        });
        if (exitCode !== 0)
            throw new CommandError(`Desktop command exited with ${exitCode}`, exitCode);
    } finally {
        await releaseDesktopLease(lease);
    }
}

// This CLI entry point is exported (despite unicorn/no-exports-in-scripts) so
// switch-worktree.test.ts can drive full commands in-process without spawning a subprocess.
// eslint-disable-next-line unicorn/no-exports-in-scripts -- consumed by switch-worktree.test.ts
export async function runCli(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        console.log(USAGE);
        return;
    }
    const arguments_ = parseArguments(argv);
    switch (arguments_.command) {
        case 'create': {
            const branch = oneOperand(arguments_);
            const result = await createWorktree({
                base: arguments_.base,
                branch: branch!,
                cwd: process.cwd(),
                install: arguments_.json
                    ? (path) => installWorktreeDependencies(path, true)
                    : undefined,
            });
            print(arguments_.json ? result : result.path, arguments_.json);
            return;
        }
        case 'switch': {
            const result = await switchWorktree(
                process.cwd(),
                oneOperand(arguments_)!,
                arguments_.json ? (path) => installWorktreeDependencies(path, true) : undefined,
            );
            print(arguments_.json ? result : result.path, arguments_.json);
            return;
        }
        case 'list': {
            if (arguments_.operands.length > 0)
                throw new CommandError('list does not accept a target', 2);
            print(await listWorktreeStatus(process.cwd()), arguments_.json);
            return;
        }
        case 'doctor': {
            const result = await doctorWorktree(process.cwd(), oneOperand(arguments_, true));
            print(result, arguments_.json);
            if (!result.valid) throw new CommandError('Worktree doctor found blocking errors');
            return;
        }
        case 'dev': {
            if (arguments_.operands.length > 0)
                throw new CommandError('dev does not accept a target', 2);
            if (arguments_.json) print({ event: 'starting-dev', worktree: process.cwd() }, true);
            const exitCode = await developmentWorktree(process.cwd(), {
                stdoutToStderr: arguments_.json,
            });
            if (exitCode !== 0)
                throw new CommandError(`Development launcher exited with ${exitCode}`, exitCode);
            return;
        }
        case 'remove': {
            const result = await removeWorktree({
                cleanProfile: arguments_.cleanProfile,
                cwd: process.cwd(),
                target: oneOperand(arguments_)!,
            });
            print(arguments_.json ? result : result.path, arguments_.json);
            return;
        }
        case 'desktop':
            await runDesktop(arguments_);
            return;
        default:
            throw new CommandError(`Unknown command: ${arguments_.command ?? ''}\n\n${USAGE}`, 2);
    }
}

if (import.meta.main) {
    try {
        await runCli(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    }
}
