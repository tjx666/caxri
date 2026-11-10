/**
 * A command's standard output sent to a file it names: `> ci.log`, `>> ci.log`, `&> ci.log`.
 */
const OUTPUT_CAPTURE = /^(.*\S)\s+(?:&|1)?>>?\s*(\S+)$/su;

/**
 * A command that only prints a file (`tail -15 ci.log`), with the file as its last word.
 */
const CAPTURE_READ = /^(?:cat|head|tail)(?:\s.*)?\s(\S+)$/su;

/**
 * A background command often writes its output to a file and prints that file once it ends (`gh pr checks 31 --watch >
 * ci.log 2>&1; tail -15 ci.log`), because the Agent reads only the tail. That pair does what the command does, so the
 * redirection and the reads of its file are dropped. Any other redirection, or a read of a different file, is kept.
 *
 * Takes and returns a split list: each command is its pipeline stages, as `describeShellCommand` splits them.
 */
export function withoutCapturedOutput(commands: readonly string[][]): readonly string[][] {
    for (let index = 0; index < commands.length - 1; index += 1) {
        const stages = commands[index] ?? [];
        const [, command = '', file = ''] = OUTPUT_CAPTURE.exec(stages.at(-1) ?? '') ?? [];
        if (!command || file.startsWith('&')) continue;
        const isReadBack = commands
            .slice(index + 1)
            .every(
                (later) =>
                    later.length === 1 && CAPTURE_READ.exec(later[0]?.trim() ?? '')?.[1] === file,
            );
        if (isReadBack) return [...commands.slice(0, index), [...stages.slice(0, -1), command]];
    }
    return commands;
}
