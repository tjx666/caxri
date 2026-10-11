/**
 * A long, realistic Agent reply for streaming-Markdown regressions and the `benchmark:markdown` trend script. Every
 * section mixes the block kinds an Agent Chat transcript actually carries (headings, prose with inline code and file
 * references, nested and task lists, fenced code, tables, quotes, rules), so a parse-work budget measured against it
 * reflects the real mix rather than one degenerate block.
 */
export function agentReplyFixture(sections = 12): string {
    return Array.from({ length: sections }, (_, index) => section(index + 1)).join('\n\n');
}

function section(index: number): string {
    return [
        `## Step ${index}: update the request handler`,
        `I read \`src/server/handler-${index}.ts:${index * 7}\` and found that the **retry budget** is computed before the *timeout* is known, so a slow upstream exhausts it early. See [the upstream note](https://example.com/notes/${index}) for the original design.`,
        [
            `- Moved the budget calculation into \`createRetryPolicy\``,
            `- Updated src/server/policy-${index}.ts to read the timeout first`,
            `  - Kept the default of ${index * 100}ms for callers that pass nothing`,
            `  - Added a ~~temporary~~ permanent guard for negative values`,
            `- [x] Unit tests pass`,
            `- [ ] Manual check against a slow upstream`,
        ].join('\n'),
        [
            '```ts',
            `export function createRetryPolicy(timeoutMs: number, attempts = ${index}) {`,
            '    const budget = Math.max(0, timeoutMs) / attempts;',
            '    return { attempts, budget, next: (failure: number) => budget * 2 ** failure };',
            '}',
            '```',
        ].join('\n'),
        [
            '| Case | Before | After |',
            '| :--- | ---: | :---: |',
            `| fast upstream | ${index} ms | ${index} ms |`,
            `| slow upstream | fails | ${index * 3} ms |`,
            '| no timeout | `NaN` | 0 ms |',
        ].join('\n'),
        `> The remaining risk is the shared pool in \`src/server/pool.ts\`; it is out of scope for step ${index}.`,
        `1. Run \`bun run test\`\n2. Review the diff\n3. Ship it`,
        '---',
    ].join('\n\n');
}

/**
 * The successive texts a streaming reply shows, cut at deterministic chunk sizes that cycle through the range a
 * provider's text deltas usually span, ending with the complete text.
 */
export function streamingPrefixes(
    text: string,
    chunkSizes: readonly number[] = [3, 17, 41, 9, 64, 23],
): string[] {
    const prefixes: string[] = [];
    let offset = 0;
    for (let index = 0; offset < text.length; index += 1) {
        offset = Math.min(text.length, offset + chunkSizes[index % chunkSizes.length]!);
        prefixes.push(text.slice(0, offset));
    }
    return prefixes;
}
