import { readFile } from 'node:fs/promises';
import process from 'node:process';

export interface RefactorAcceptanceValidation {
    errors: string[];
    valid: boolean;
}

const fieldLabels = [
    '证据模式',
    '最近用户可见行为',
    '保留行为',
    '前后基线',
    '固定环境',
    '交互重放',
    '时序证据',
    'Intentional differences / 非目标',
] as const;

type FieldLabel = (typeof fieldLabels)[number];

function stripHtmlComments(line: string, state: { inside: boolean }): string {
    const segments: string[] = [];
    let remainder = line;
    while (remainder) {
        if (state.inside) {
            const commentEnd = remainder.indexOf('-->');
            if (commentEnd === -1) return segments.join('');
            state.inside = false;
            remainder = remainder.slice(commentEnd + 3);
        } else {
            const commentStart = remainder.indexOf('<!--');
            if (commentStart === -1) return [...segments, remainder].join('');
            segments.push(remainder.slice(0, commentStart));
            state.inside = true;
            remainder = remainder.slice(commentStart + 4);
        }
    }
    return segments.join('');
}

interface HiddenHtmlState {
    depth: number;
    tag?: string;
}

const nonRenderingHtmlTags = new Set(['head', 'script', 'style', 'template']);
const voidHtmlTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
]);

function updateHiddenHtmlDepth(line: string, state: HiddenHtmlState): void {
    if (!state.tag) return;
    const tagPattern = new RegExp(String.raw`<\/?${state.tag}\b[^>]*>`, 'giu');
    for (const match of line.matchAll(tagPattern)) {
        if (match[0].startsWith('</')) state.depth -= 1;
        else if (!/\/\s*>$/u.test(match[0]) && !voidHtmlTags.has(state.tag)) state.depth += 1;
    }
    if (state.depth <= 0) {
        state.depth = 0;
        state.tag = undefined;
    }
}

function hasHiddenHtmlBlockStart(line: string, state: HiddenHtmlState): boolean {
    for (const match of line.matchAll(/<[a-z][^>]*>/giu)) {
        const tag = match[0]
            .slice(1)
            .match(/^[a-z][\w-]*/iu)?.[0]
            .toLowerCase();
        if (!tag) continue;
        const normalized = match[0].toLowerCase().replaceAll(/\s+/gu, ' ');
        const compact = normalized.replaceAll(' ', '');
        const isHidden =
            nonRenderingHtmlTags.has(tag) ||
            /\shidden[\s=>]/u.test(normalized) ||
            (compact.includes('style=') && compact.includes('display:none'));
        if (!isHidden) continue;
        if (!voidHtmlTags.has(tag) && !/\/\s*>$/u.test(match[0])) {
            state.tag = tag;
            updateHiddenHtmlDepth(line.slice(match.index), state);
        }
        return true;
    }
    return false;
}

function markdownLinesOutsideFences(body: string): string[] {
    const visible: string[] = [];
    let fence: { length: number; marker: '`' | '~' } | undefined;
    const htmlComment = { inside: false };
    const hiddenHtml: HiddenHtmlState = { depth: 0 };
    for (const rawLine of body.split(/\r?\n/u)) {
        const line = stripHtmlComments(rawLine, htmlComment);
        if (hiddenHtml.tag) {
            updateHiddenHtmlDepth(line, hiddenHtml);
            continue;
        }
        if (hasHiddenHtmlBlockStart(line, hiddenHtml)) continue;
        const markerMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
        const marker = markerMatch?.[1];
        if (fence) {
            const suffix = markerMatch ? line.slice(markerMatch[0].length) : undefined;
            if (
                suffix !== undefined &&
                /^[\t ]*$/u.test(suffix) &&
                marker?.startsWith(fence.marker) &&
                marker.length >= fence.length
            )
                fence = undefined;
            continue;
        }
        if (marker) {
            fence = { length: marker.length, marker: marker[0] as '`' | '~' };
            continue;
        }
        visible.push(line);
    }
    return visible;
}

function acceptanceSections(body: string): string[] {
    const lines = markdownLinesOutsideFences(body);
    const starts = lines.flatMap((line, index) =>
        /^##\s+Acceptance 方案\s*$/u.test(line) ? [index] : [],
    );
    return starts.map((start) => {
        const followingHeading = lines.slice(start + 1).findIndex((line) => /^##\s+/u.test(line));
        const end = followingHeading === -1 ? lines.length : start + 1 + followingHeading;
        return lines.slice(start + 1, end).join('\n');
    });
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function field(section: string, label: FieldLabel): string | undefined {
    return section.match(
        new RegExp(String.raw`^\s*-\s+\*\*${escapeRegExp(label)}\*\*[：:]\s*(.+)\s*$`, 'mu'),
    )?.[1];
}

function isMeaningful(value: string | undefined): value is string {
    return Boolean(
        value &&
        value.trim().length >= 8 &&
        !/^(?:TBD|TODO|待定|N\/A|对比截图|CI (?:passed|通过))\.?$/iu.test(value.trim()),
    );
}

function hasEvery(value: string, patterns: readonly RegExp[]): boolean {
    return patterns.every((pattern) => pattern.test(value));
}

function hasNotApplicableReason(value: string): boolean {
    const trimmedValue = value.trim();
    const marker = trimmedValue.match(/^(?:不适用|not applicable)[：:]/iu);
    if (!marker) return false;
    const reason = trimmedValue.slice(marker[0].length).replaceAll(/\s/gu, '');
    return [...reason].length >= 4;
}

export function validateRefactorAcceptancePlan(body: string): RefactorAcceptanceValidation {
    const sections = acceptanceSections(body);
    if (sections.length === 0)
        return { errors: ['Refactor issue 缺少 ## Acceptance 方案'], valid: false };
    if (sections.length > 1)
        return {
            errors: ['Refactor issue 必须且只能包含一个可见的 ## Acceptance 方案'],
            valid: false,
        };
    const [section] = sections;

    const values = new Map<FieldLabel, string>();
    const errors: string[] = [];
    for (const label of fieldLabels) {
        const value = field(section, label);
        if (label === '证据模式') {
            if (value?.trim()) values.set(label, value);
            else errors.push(`Acceptance 方案缺少 **${label}**`);
        } else if (isMeaningful(value)) values.set(label, value);
        else errors.push(`Acceptance 方案缺少 **${label}**`);
    }

    const evidenceMode = values.get('证据模式');
    const isNonVisual = evidenceMode?.startsWith('非视觉') ?? false;
    if (evidenceMode && !/^(?:视觉|非视觉)$/u.test(evidenceMode.trim()))
        errors.push('证据模式必须是“视觉”或“非视觉”');

    const baseline = values.get('前后基线');
    if (baseline && (!/重构前|before/iu.test(baseline) || !/重构后|after/iu.test(baseline)))
        errors.push('前后基线必须同时说明重构前和重构后');

    const environment = values.get('固定环境');
    if (environment) {
        const common = [
            /(?:Project|fixture|项目|夹具)/iu,
            /(?:persisted state|持久化状态|state)/iu,
        ];
        const modeSpecific = isNonVisual
            ? [/(?:configuration|配置)/iu, /(?:version|版本)/iu]
            : [/(?:theme|主题)/iu, /(?:window size|窗口尺寸)/iu, /(?:viewport|视口)/iu];
        const hasComparableEnvironment =
            /同一|相同|same|fixed|固定/iu.test(environment) &&
            hasEvery(environment, [...common, ...modeSpecific]);
        if (!hasComparableEnvironment) errors.push('固定环境未覆盖该证据模式要求的可比环境');
        if (
            isNonVisual &&
            (!hasEvery(environment, [
                /(?:theme|主题)/iu,
                /(?:window size|窗口尺寸)/iu,
                /(?:viewport|视口)/iu,
            ]) ||
                !/不适用|irrelevant|not applicable/iu.test(environment))
        )
            errors.push('非视觉固定环境必须明确 theme、window size 和 viewport 不适用');
    }

    const replay = values.get('交互重放');
    if (replay) {
        if (isNonVisual) {
            if (
                (!/API|CLI|request/iu.test(replay) ||
                    !/failure injection|失败注入/iu.test(replay)) &&
                !hasNotApplicableReason(replay)
            )
                errors.push('非视觉交互重放必须包含 API/CLI sequence 与 failure injection');
        } else if (
            !/click|double-click|keyboard|Refresh|Retry|navigation|restart|state restoration|点击|双击|键盘|刷新|重试|导航|重启|状态恢复/iu.test(
                replay,
            ) &&
            !hasNotApplicableReason(replay)
        )
            errors.push('视觉交互重放必须枚举 UI 动作或解释为何不适用');
    }

    const temporalEvidence = values.get('时序证据');
    if (temporalEvidence) {
        if (
            isNonVisual &&
            !/structured logs?|结构化日志|event sequence|事件顺序|receipt/iu.test(
                temporalEvidence,
            ) &&
            !hasNotApplicableReason(temporalEvidence)
        )
            errors.push('非视觉时序证据必须使用 structured logs/event receipt');
        else if (
            !isNonVisual &&
            !/GIF|video|视频/iu.test(temporalEvidence) &&
            !hasNotApplicableReason(temporalEvidence)
        )
            errors.push('视觉时序证据必须使用 video/GIF，或解释为何不适用');
    }

    return { errors, valid: errors.length === 0 };
}

export function assertRefactorAcceptancePlan(body: string): void {
    const result = validateRefactorAcceptancePlan(body);
    if (!result.valid) throw new Error(result.errors.join('\n'));
}

function help(): string {
    return `Validate the parity Acceptance contract for a refactor issue

Usage:
  bun run .agents/skills/file-issue/scripts/validate-refactor-acceptance.ts --body-file PATH`;
}

async function main(arguments_: string[]): Promise<void> {
    if (arguments_.includes('--help')) {
        process.stdout.write(`${help()}\n`);
        return;
    }
    const bodyFileIndex = arguments_.indexOf('--body-file');
    const bodyFile = bodyFileIndex === -1 ? undefined : arguments_[bodyFileIndex + 1];
    if (!bodyFile) throw new Error('--body-file is required');
    assertRefactorAcceptancePlan(await readFile(bodyFile, 'utf8'));
    process.stdout.write('Refactor Acceptance contract passed\n');
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
