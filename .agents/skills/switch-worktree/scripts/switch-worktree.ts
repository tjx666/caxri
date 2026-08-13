#!/usr/bin/env bun

import { acquireDesktopLease, releaseDesktopLease } from './desktop-lease';
import { CommandError, runInherited } from './process';
import {
    createWorktree,
    devWorktree,
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

function parseArguments(argv: string[]): ParsedArguments {
    const separator = argv.indexOf('--');
    const regular = separator < 0 ? argv : argv.slice(0, separator);
    const result: ParsedArguments = {
        cleanProfile: false,
        command: regular.shift(),
        json: false,
        operands: [],
        trailing: separator < 0 ? [] : argv.slice(separator + 1),
    };
    for (let index = 0; index < regular.length; index += 1) {
        const value = regular[index];
        if (value === '--json') result.json = true;
        else if (value === '--clean-profile') result.cleanProfile = true;
        else if (value === '--base' || value === '--label') {
            const option = regular[++index];
            if (!option || option.startsWith('--')) {
                throw new CommandError(`${value} requires a value`, 2);
            }
            if (value === '--base') result.base = option;
            else result.label = option;
        } else if (value === '--help' || value === '-h') {
            throw new CommandError(USAGE, 0);
        } else if (value.startsWith('-')) {
            throw new CommandError(`Unknown option: ${value}\n\n${USAGE}`, 2);
        } else result.operands.push(value);
    }
    return result;
}

function oneOperand(args: ParsedArguments, optional = false): string | undefined {
    if (args.operands.length > 1 || (!optional && args.operands.length !== 1)) {
        throw new CommandError('Expected exactly one branch or path', 2);
    }
    return args.operands[0];
}

function print(value: unknown, json: boolean): void {
    if (json) console.log(JSON.stringify(value, null, 2));
    else if (typeof value === 'string') console.log(value);
    else console.log(JSON.stringify(value, null, 2));
}

export function desktopCommandEnvironment(
    environment: NodeJS.ProcessEnv,
    coordinatorToken: string,
): NodeJS.ProcessEnv {
    return { ...environment, CAXRI_DESKTOP_COORDINATOR_TOKEN: coordinatorToken };
}

async function runDesktop(args: ParsedArguments): Promise<void> {
    if (!args.label) throw new CommandError('desktop requires --label <name>', 2);
    if (args.trailing.length === 0) throw new CommandError('desktop requires -- <command>', 2);
    const lease = await acquireDesktopLease(process.cwd(), args.label);
    if (args.json) {
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
        const exitCode = await runInherited(args.trailing[0], args.trailing.slice(1), {
            cwd: process.cwd(),
            env: desktopCommandEnvironment(process.env, lease.token),
            stdoutToStderr: args.json,
        });
        if (exitCode !== 0)
            throw new CommandError(`Desktop command exited with ${exitCode}`, exitCode);
    } finally {
        await releaseDesktopLease(lease);
    }
}

export async function runCli(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        console.log(USAGE);
        return;
    }
    const args = parseArguments(argv);
    switch (args.command) {
        case 'create': {
            const branch = oneOperand(args);
            const result = await createWorktree({
                base: args.base,
                branch: branch!,
                cwd: process.cwd(),
                install: args.json ? (path) => installWorktreeDependencies(path, true) : undefined,
            });
            print(args.json ? result : result.path, args.json);
            return;
        }
        case 'switch': {
            const result = await switchWorktree(
                process.cwd(),
                oneOperand(args)!,
                args.json ? (path) => installWorktreeDependencies(path, true) : undefined,
            );
            print(args.json ? result : result.path, args.json);
            return;
        }
        case 'list': {
            if (args.operands.length > 0)
                throw new CommandError('list does not accept a target', 2);
            print(await listWorktreeStatus(process.cwd()), args.json);
            return;
        }
        case 'doctor': {
            const result = await doctorWorktree(process.cwd(), oneOperand(args, true));
            print(result, args.json);
            if (!result.valid) throw new CommandError('Worktree doctor found blocking errors');
            return;
        }
        case 'dev': {
            if (args.operands.length > 0) throw new CommandError('dev does not accept a target', 2);
            if (args.json) print({ event: 'starting-dev', worktree: process.cwd() }, true);
            const exitCode = await devWorktree(process.cwd(), { stdoutToStderr: args.json });
            if (exitCode !== 0)
                throw new CommandError(`Development launcher exited with ${exitCode}`, exitCode);
            return;
        }
        case 'remove': {
            const result = await removeWorktree({
                cleanProfile: args.cleanProfile,
                cwd: process.cwd(),
                target: oneOperand(args)!,
            });
            print(args.json ? result : result.path, args.json);
            return;
        }
        case 'desktop':
            await runDesktop(args);
            return;
        default:
            throw new CommandError(`Unknown command: ${args.command ?? ''}\n\n${USAGE}`, 2);
    }
}

if (import.meta.main) {
    void runCli(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    });
}
