#!/usr/bin/env bun

import process from 'node:process';

import { readWorkspaceDependencies, resolveXtermBetaLine } from './xterm-beta-line-core';

interface ParsedArguments {
    help: boolean;
    json: boolean;
    resolve: string[];
}

/**
 * Applies one CLI argument to `options` and returns the argv index the loop should resume from. Isolated from the loop
 * body so the switch's `break` statements are not nested inside a loop.
 */
function applyArgument(
    argument: string,
    argv: string[],
    index: number,
    options: ParsedArguments,
): number {
    switch (argument) {
        case '--help':
        case '-h': {
            options.help = true;
            return index;
        }
        case '--json': {
            options.json = true;
            return index;
        }
        case '--resolve': {
            const name = argv[index + 1];
            if (!name) throw new Error('Missing --resolve package name');
            options.resolve.push(name);
            return index + 1;
        }
        default: {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
}

function parseArguments(argv: string[]): ParsedArguments {
    const options: ParsedArguments = { help: false, json: false, resolve: [] };
    let index = 0;
    while (index < argv.length) {
        index = applyArgument(argv[index], argv, index, options) + 1;
    }
    return options;
}

function help(): string {
    return `Resolve and verify one exact xterm beta package line without installing it.

Usage:
  bun run .agents/skills/go/scripts/xterm-beta-line.ts [--resolve @xterm/PACKAGE] [--json]

The resolver reads exact manifest versions, resolves new packages through their beta tag, and
requires one gitHead plus a compatible @xterm/xterm peer before printing exact ni specs.`;
}

async function main(argv: string[]): Promise<void> {
    const options = parseArguments(argv);
    if (options.help) {
        console.log(help());
        return;
    }
    const manifest = await readWorkspaceDependencies();
    const result = await resolveXtermBetaLine({ ...manifest, resolve: options.resolve });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(`xterm gitHead: ${result.gitHead}`);
    for (const item of result.packages) {
        console.log(`${item.name}@${item.version} (${item.source})`);
    }
    if (result.installSpecs.length > 0) {
        console.log(`Install with: ni ${result.installSpecs.join(' ')}`);
    }
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
