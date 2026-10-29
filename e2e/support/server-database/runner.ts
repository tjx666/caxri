import process from 'node:process';

/**
 * Bun entry point for acceptance seeds that need Server database internals.
 *
 * The Server's migration manifest imports `.sql?raw`, which Bun resolves but Playwright's loader cannot. Scenarios
 * therefore never import `apps/server/src/domains/db` themselves: they call `runServerDatabase`
 * (../run-server-database.ts), which spawns this file. Usage: `bun runner.ts <module-name> <json-input>`;
 * `<module-name>.ts` beside this file must export `run(input)`. The JSON result is printed after RESULT_MARKER so
 * Server logs on stdout cannot corrupt it.
 */
import { RESULT_MARKER } from './marker';

const [name, rawInput] = process.argv.slice(2);
if (!name || !/^[a-z-]+$/.test(name)) throw new Error('A server-database module name is required');
const module_ = (await import(`./${name}.ts`)) as { run(input: unknown): unknown };
const result = await module_.run(rawInput ? (JSON.parse(rawInput) as unknown) : undefined);
process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result ?? null)}\n`);
