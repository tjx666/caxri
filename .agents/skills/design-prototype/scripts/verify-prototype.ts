/**
 * Headless render check for a design prototype: open the HTML over `file://`, wait for React to mount and
 * `@tailwindcss/browser` to apply the semantic tokens, capture page/console errors, and save a screenshot for visual
 * review.
 *
 * Usage: `bun run .agents/skills/design-prototype/scripts/verify-prototype.ts <prototype.html> [screenshot.png]` Exits
 * 1 when the page throws or logs a console error. Always Read the screenshot afterwards: a prototype is a visual
 * deliverable.
 */
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const htmlPath = process.argv.at(2);
const screenshotArgument = process.argv.at(3);
if (!htmlPath) {
    console.error(
        'usage: bun run .agents/skills/design-prototype/scripts/verify-prototype.ts <prototype.html> [screenshot.png]',
    );
    process.exit(1);
}
const absoluteHtmlPath = path.resolve(htmlPath);
const screenshotPath = path.resolve(
    screenshotArgument ?? `${absoluteHtmlPath.replace(/\.html?$/, '')}.png`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(`file://${absoluteHtmlPath}`);
await page.waitForSelector('#root *', { timeout: 30_000 });
// Tailwind compiled ⇔ a semantic token utility resolves; the raw `:root` colors alone would
// also render, so probe a bridged utility instead of sleeping an arbitrary interval.
await page.waitForFunction(
    () => {
        const probe = document.createElement('div');
        probe.className = 'bg-surface';
        document.body.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return background !== 'rgba(0, 0, 0, 0)' && background !== '';
    },
    undefined,
    { timeout: 15_000 },
);
await page.screenshot({ path: screenshotPath });
await browser.close();

if (errors.length > 0) {
    console.error(`page errors:\n${errors.join('\n')}`);
    process.exit(1);
}
console.log(`ok - screenshot: ${screenshotPath}`);
