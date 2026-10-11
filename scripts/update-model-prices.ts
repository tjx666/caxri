/**
 * Regenerates the model price snapshot bundled with Server Core (`bundled-prices.generated.json`), used when the live
 * LiteLLM list cannot be fetched. Run `bun run scripts/update-model-prices.ts` and commit the regenerated file; do not
 * edit it by hand.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MODEL_PRICES_URL, projectLiteLlmPrices } from '../apps/server/src/domains/usage/pricing';

const response = await fetch(MODEL_PRICES_URL);
if (!response.ok) throw new Error(`Price list request failed: ${response.status}`);
/**
 * Model families Caxri's Agent providers report in their transcripts.
 */
const BUNDLED_MODEL_PATTERN = /^(?:anthropic\/|openai\/|xai\/)?(?:claude|gpt|codex|grok|o\d)/;
const prices = projectLiteLlmPrices(await response.json());
const entries = Object.entries(prices)
    .filter(([model]) => BUNDLED_MODEL_PATTERN.test(model))
    .toSorted(([left], [right]) => left.localeCompare(right));
const body = entries
    .map(([model, price]) => `    ${JSON.stringify(model)}: ${JSON.stringify(price)}`)
    .join(',\n');
const target = join(
    import.meta.dirname,
    '../apps/server/src/domains/usage/bundled-prices.generated.json',
);
// JSON rather than a TypeScript module: entries with long-context or service tiers wrap across lines, and the snapshot
// would outgrow the source line limit that applies to TypeScript files.
await writeFile(target, `{\n${body}\n}\n`);
console.log(`Wrote ${entries.length} model prices to ${target}`);
