import { z } from 'zod';

import { ACCEPTANCE_UPDATE_FIXTURE_ID } from '../../../../apps/desktop/src/main/acceptance-update';

/**
 * Main-process fixtures a frozen plan item may declare. The declaration is the only admission list: the launcher arms a
 * fixture for exactly the launched case that declared it, so a new case needs a plan entry, never a Main edit.
 */
export const planFixtureFields = {
    /**
     * `true` lets **Import Theme** read its file choice from the per-profile command file. `false` records that a case
     * mentioning theme import deliberately does not use it; only such a case, launched under the explicit native-dialog
     * authorization, may reach the real macOS panel. Undeclared cases can reach neither.
     */
    themeImportFixture: z.boolean().optional(),
    /**
     * Replaces GitHub release discovery with one fixed `available` update; download and install stay disabled.
     */
    updateFixture: z.literal(ACCEPTANCE_UPDATE_FIXTURE_ID).optional(),
};

export interface DeclaredPlanFixtures {
    themeImportFixture?: boolean;
    updateFixture?: typeof ACCEPTANCE_UPDATE_FIXTURE_ID;
}

interface FixturePlanItem extends DeclaredPlanFixtures {
    expected: string;
    id: string;
    method: string;
    surface: string;
    title: string;
}

/**
 * Wording that means a case drives **Import Theme** or picks a theme file. Undeclared, such a case would fail at
 * execution time with Main's rejection; matching it at freeze time turns that late failure into an immediate one that
 * names the case. Main's rejection still covers any wording this misses, so a miss never reaches the native panel.
 */
const THEME_IMPORT_WORDING =
    /import(?:ing|s|ed)? (?:a |the )?theme|theme[ ._-]?(?:import|file)|\.itermcolors|\.vsix\b|导入.{0,4}主题|主题(?:导入|文件)/iu;

/**
 * Freeze-time contract for fixture declarations. Runs when the plan is frozen and again when a case launches, so a
 * `result.json` edited after `init` still cannot launch an undeclared theme-import case or arm a fixture on a
 * non-desktop case.
 */
export function validatePlanFixtureDeclarations(plan: readonly FixturePlanItem[]): void {
    for (const item of plan) {
        const declared = [
            item.themeImportFixture !== undefined && 'themeImportFixture',
            item.updateFixture !== undefined && 'updateFixture',
        ].filter(Boolean);
        if (item.surface !== 'desktop' && declared.length > 0) {
            throw new Error(
                `Acceptance case ${item.id} declares ${declared.join(', ')}, which only a desktop case can use`,
            );
        }
        if (
            item.surface === 'desktop' &&
            item.themeImportFixture === undefined &&
            [item.id, item.title, item.method, item.expected].some((text) =>
                THEME_IMPORT_WORDING.test(text),
            )
        ) {
            throw new Error(
                `Acceptance case ${item.id} imports a theme but does not declare themeImportFixture; set it to true to use the file-choice fixture, or false for a native-dialog manual step`,
            );
        }
    }
}
