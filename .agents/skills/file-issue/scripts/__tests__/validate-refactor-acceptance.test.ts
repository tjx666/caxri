import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { validateRefactorAcceptancePlan } from '../validate-refactor-acceptance';

function fixture(name: string): Promise<string> {
    return readFile(
        new URL(`../__fixtures__/refactor-acceptance/${name}`, import.meta.url),
        'utf8',
    );
}

describe('validateRefactorAcceptancePlan', () => {
    it.each([
        ['missing-preserved-behaviors.md', 'Acceptance 方案缺少 **保留行为**'],
        ['fenced-example-bypass.md', '前后基线必须同时说明重构前和重构后'],
        ['fence-trailing-info-bypass.txt', 'Refactor issue 缺少 ## Acceptance 方案'],
        [
            'duplicate-acceptance-sections.md',
            'Refactor issue 必须且只能包含一个可见的 ## Acceptance 方案',
        ],
        ['html-comment-bypass.md', '前后基线必须同时说明重构前和重构后'],
        ['html-hidden-bypass.md', 'Refactor issue 缺少 ## Acceptance 方案'],
        ['only-new-screenshot.md', '前后基线必须同时说明重构前和重构后'],
        ['missing-fixed-environment.md', 'Acceptance 方案缺少 **固定环境**'],
        ['missing-interaction-replay.md', 'Acceptance 方案缺少 **交互重放**'],
        ['missing-temporal-evidence.md', 'Acceptance 方案缺少 **时序证据**'],
        [
            'missing-non-visual-desktop-boundary.md',
            '非视觉固定环境必须明确 theme、window size 和 viewport 不适用',
        ],
        ['visual-api-only-replay.md', '视觉交互重放必须枚举 UI 动作或解释为何不适用'],
        [
            'non-visual-video-only-temporal.md',
            '非视觉时序证据必须使用 structured logs/event receipt',
        ],
        [
            'missing-intentional-differences.md',
            'Acceptance 方案缺少 **Intentional differences / 非目标**',
        ],
    ])('rejects the incomplete refactor fixture %s', async (name, expectedError) => {
        const result = validateRefactorAcceptancePlan(await fixture(name));

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(expectedError);
    });

    it.each(['complete-visual.md', 'complete-non-visual.md'])(
        'accepts the complete refactor fixture %s',
        async (name) => {
            expect(validateRefactorAcceptancePlan(await fixture(name))).toEqual({
                errors: [],
                valid: true,
            });
        },
    );

    it('requires a reason instead of a bare N/A waiver', async () => {
        const body = (await fixture('complete-visual.md'))
            .replace(/- \*\*交互重放\*\*：.+/u, '- **交互重放**：N/A')
            .replace(/- \*\*时序证据\*\*：.+/u, '- **时序证据**：N/A');

        expect(validateRefactorAcceptancePlan(body).errors).toEqual(
            expect.arrayContaining([
                'Acceptance 方案缺少 **交互重放**',
                'Acceptance 方案缺少 **时序证据**',
            ]),
        );
    });

    it('accepts an explicit reason when no visual interaction or sequence applies', async () => {
        const body = (await fixture('complete-visual.md'))
            .replace(
                /- \*\*交互重放\*\*：.+/u,
                '- **交互重放**：不适用：该 read-only surface 没有可执行动作。',
            )
            .replace(
                /- \*\*时序证据\*\*：.+/u,
                '- **时序证据**：not applicable: the settled surface has no temporal claim.',
            );

        expect(validateRefactorAcceptancePlan(body)).toEqual({ errors: [], valid: true });
    });

    it('counts actual reason characters and supports non-visual not-applicable evidence', async () => {
        const tooShort = (await fixture('complete-visual.md')).replace(
            /- \*\*交互重放\*\*：.+/u,
            '- **交互重放**：not applicable: abc',
        );
        expect(validateRefactorAcceptancePlan(tooShort).errors).toContain(
            '视觉交互重放必须枚举 UI 动作或解释为何不适用',
        );

        const nonVisual = (await fixture('complete-non-visual.md'))
            .replace(
                /- \*\*交互重放\*\*：.+/u,
                '- **交互重放**：不适用：该内部 receipt 没有独立 interaction。',
            )
            .replace(
                /- \*\*时序证据\*\*：.+/u,
                '- **时序证据**：not applicable: this receipt has no temporal claim.',
            );
        expect(validateRefactorAcceptancePlan(nonVisual)).toEqual({ errors: [], valid: true });
    });

    it('requires exact evidence modes and a leading not-applicable marker', async () => {
        const extendedMode = (await fixture('complete-visual.md')).replace(
            '- **证据模式**：视觉',
            '- **证据模式**：视觉 extra',
        );
        expect(validateRefactorAcceptancePlan(extendedMode).errors).toContain(
            '证据模式必须是“视觉”或“非视觉”',
        );

        const embeddedMarker = (await fixture('complete-visual.md')).replace(
            /- \*\*交互重放\*\*：.+/u,
            '- **交互重放**：补充说明 not applicable: the surface has no interaction.',
        );
        expect(validateRefactorAcceptancePlan(embeddedMarker).errors).toContain(
            '视觉交互重放必须枚举 UI 动作或解释为何不适用',
        );
    });
});
