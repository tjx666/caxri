import type { Env, MarkdownIt, StateCore, Token } from 'markdown-it';
import createMarkdownIt from 'markdown-it';

import type { DocumentLocation } from './document-paths.js';
import { isExternalTarget, isInPageTarget, resolveDocumentTarget } from './document-paths.js';
import { slugify } from './slug.js';
import type { MarkdownAsset, MarkdownCodeBlock, MarkdownDiagram, MarkdownLink } from './types.js';

/**
 * Collected while one document renders, then handed back to the host alongside the HTML.
 *
 * Extends markdown-it's `Env` so the same object can be threaded through `render` and read back inside a rule.
 */
export interface RenderEnvironment extends Env {
    location: DocumentLocation;
    assets: MarkdownAsset[];
    codeBlocks: MarkdownCodeBlock[];
    diagrams: MarkdownDiagram[];
    links: MarkdownLink[];
    sequence: number;
    slugs: Map<string, number>;
}

export function createRenderEnvironment(location: DocumentLocation): RenderEnvironment {
    return {
        location,
        assets: [],
        codeBlocks: [],
        diagrams: [],
        links: [],
        sequence: 0,
        slugs: new Map(),
    };
}

const TASK_MARKER = /^\[([ x])\]\s+/i;

function nextId(environment: RenderEnvironment, prefix: string): string {
    environment.sequence += 1;
    return `${prefix}-${environment.sequence}`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function lineAttribute(token: Token): string {
    return token.map ? ` data-line="${token.map[0]}"` : '';
}

/**
 * Markdown-it types attribute values as `string | number`; every attribute this pipeline reads is textual.
 */
function attributeText(token: Token, name: string): string {
    const value = token.attrGet(name);
    return value === null ? '' : String(value);
}

/**
 * Records the source line of every top-level block so the host can keep the preview aligned with the editor while the
 * user scrolls. Nested blocks are skipped: one anchor per top-level block is enough to interpolate a position, and
 * annotating every token bloats the DOM for no added precision.
 */
function recordSourceLines(state: StateCore): void {
    for (const token of state.tokens) {
        if (token.map && token.level === 0 && token.nesting >= 0)
            token.attrSet('data-line', String(token.map[0]));
    }
}

/**
 * Gives every heading a stable anchor so in-page links and future "reveal heading" navigation resolve.
 */
function anchorHeadings(state: StateCore): void {
    const environment = state.env as RenderEnvironment;
    const { tokens } = state;
    for (const [index, token] of tokens.entries()) {
        if (token.type !== 'heading_open') continue;
        const inline = tokens[index + 1];
        if (inline?.type !== 'inline') continue;
        token.attrSet('id', slugify(inline.content, environment.slugs));
    }
}

/**
 * Renders GitHub task list items as real checkboxes.
 *
 * Written here rather than pulled from `markdown-it-task-lists`, whose last release predates markdown-it 14: the rule
 * is a dozen lines and this keeps a stale transitive dependency out of every preview client.
 */
function renderTaskLists(state: StateCore): void {
    const { tokens } = state;
    for (const [index, token] of tokens.entries()) {
        if (token.type !== 'inline') continue;
        if (tokens[index - 1]?.type !== 'paragraph_open') continue;
        const listItem = tokens[index - 2];
        if (listItem?.type !== 'list_item_open') continue;
        const first = token.children?.[0];
        if (first?.type !== 'text') continue;
        const marker = TASK_MARKER.exec(first.content);
        if (!marker) continue;
        first.content = first.content.slice(marker[0].length);
        const checkbox = new state.Token('html_inline', '', 0);
        const checked = marker[1] !== ' ' ? ' checked' : '';
        checkbox.content = `<input class="caxri-markdown-checkbox" type="checkbox" disabled${checked}>`;
        token.children?.unshift(checkbox);
        listItem.attrJoin('class', 'caxri-markdown-task');
    }
}

/**
 * Builds the renderer.
 *
 * `html: true` keeps the inline HTML that real READMEs depend on (`<details>`, centered banners). The output is
 * therefore untrusted and the host must sanitize it: the same split VS Code uses between its Markdown engine and its
 * preview webview.
 */
export function createMarkdownEngine(): MarkdownIt {
    const engine = createMarkdownIt({ html: true, linkify: true, typographer: false });

    /* eslint-disable unicorn/prefer-single-call -- markdown-it's rule ruler takes one named rule per call. */
    engine.core.ruler.push('caxri_source_lines', recordSourceLines);
    engine.core.ruler.push('caxri_heading_anchors', anchorHeadings);
    engine.core.ruler.push('caxri_task_lists', renderTaskLists);
    /* eslint-enable unicorn/prefer-single-call */

    engine.renderer.rules.fence = (tokens, index, _options, environment) => {
        const token = tokens[index]!;
        const collector = environment as RenderEnvironment;
        const language = token.info.trim().split(/\s+/u, 1)[0] ?? '';
        const line = lineAttribute(token);
        if (language.toLowerCase() === 'mermaid') {
            const id = nextId(collector, 'diagram');
            collector.diagrams.push({ id, source: token.content });
            return `<div class="caxri-markdown-diagram" data-caxri-diagram="${id}"${line}></div>`;
        }
        const id = nextId(collector, 'code');
        collector.codeBlocks.push({ id, language, code: token.content });
        return (
            `<pre class="caxri-markdown-code" data-caxri-code="${id}"` +
            ` data-caxri-language="${escapeHtml(language)}"${line}>` +
            `<code>${escapeHtml(token.content)}</code></pre>`
        );
    };

    /**
     * Emits an image with no `src`. The host resolves the bytes through its authorized file channel and assigns an
     * object URL after mount, so the document itself never carries a filesystem path that a CSP would have to allow.
     */
    engine.renderer.rules.image = (tokens, index, options, environment, self) => {
        const token = tokens[index]!;
        const collector = environment as RenderEnvironment;
        const source = attributeText(token, 'src');
        const id = nextId(collector, 'asset');
        const asset: MarkdownAsset = { id, source };
        if (isExternalTarget(source)) asset.url = source;
        else {
            const path = resolveDocumentTarget(source, collector.location);
            if (path) asset.path = path;
        }
        collector.assets.push(asset);
        const alt = self.renderInlineAsText(token.children ?? [], options, environment);
        const title = attributeText(token, 'title');
        return (
            `<img class="caxri-markdown-image" data-caxri-asset="${id}" alt="${escapeHtml(alt)}"` +
            `${title ? ` title="${escapeHtml(title)}"` : ''}>`
        );
    };

    engine.renderer.rules.link_open = (tokens, index, options, environment, self) => {
        const token = tokens[index]!;
        const collector = environment as RenderEnvironment;
        const href = attributeText(token, 'href');
        if (!isInPageTarget(href)) {
            const id = nextId(collector, 'link');
            const external = isExternalTarget(href);
            const path = external ? undefined : resolveDocumentTarget(href, collector.location);
            collector.links.push({ id, href, external, ...(path && { path }) });
            token.attrSet('data-caxri-link', id);
            // The host decides what a click means (open externally, open a tab); the document must not navigate itself.
            if (!external) token.attrSet('href', '#');
        }
        return self.renderToken(tokens, index, options);
    };

    return engine;
}
