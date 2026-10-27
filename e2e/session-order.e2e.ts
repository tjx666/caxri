import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState, SessionRecord } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';

/**
 * Synthetic HTML drag events exercise the product handlers without taking macOS foreground focus.
 */
async function dragEvent(
    page: Page,
    id: string,
    type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
    edge: 'before' | 'after' = 'before',
) {
    await page.evaluate(
        ({ id, type, edge }) => {
            const row = document.querySelector<HTMLElement>(
                `[data-session-id="${CSS.escape(id)}"]`,
            );
            if (!row) throw new Error('Session drag fixture missing');
            const state = globalThis as unknown as { sessionDragTransfer?: DataTransfer };
            if (type === 'dragstart') state.sessionDragTransfer = new DataTransfer();
            const bounds = row.getBoundingClientRect();
            row.dispatchEvent(
                new DragEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: state.sessionDragTransfer,
                    clientY: edge === 'before' ? bounds.top + 1 : bounds.bottom - 1,
                }),
            );
        },
        { id, type, edge },
    );
}

test('Session dragging preserves order across restart and yields only to subsequent activity', async () => {
    const testInfo = test.info();
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-order-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const options = { userDataDir: join(directory, 'profile'), testRootPath: root };
    let running = await launchCaxri(options);
    try {
        await createProjectSession(running.page);
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const a = bootstrap.sessions[0];
        const terminal = bootstrap.terminals.find((row) => row.sessionId === a.id)!;
        const { session: b } = await pageRequest<{ session: SessionRecord }>(
            running.page,
            'session.create',
            { projectId: a.projectId, defaultAgent: null },
        );
        const { session: c } = await pageRequest<{ session: SessionRecord }>(
            running.page,
            'session.create',
            { projectId: a.projectId, defaultAgent: null },
        );
        await pageRequest(running.page, 'session.rename', {
            sessionId: a.id,
            title: 'Alpha',
        });
        await pageRequest(running.page, 'session.rename', {
            sessionId: b.id,
            title: 'Beta',
        });
        await pageRequest(running.page, 'session.rename', {
            sessionId: c.id,
            title: 'Gamma',
        });
        const order = () =>
            running.page
                .locator('.session-card')
                .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId));
        await expect.poll(order).toEqual([c.id, b.id, a.id]);
        const alphaRow = running.page.locator(`[data-session-id="${a.id}"]`);
        await expect(alphaRow).toHaveAttribute('aria-describedby', /\S+/);
        await alphaRow.hover();
        await expect(running.page.locator('.session-activity-card')).toBeVisible();
        await running.page.locator(`[data-session-id="${a.id}"]`).click();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${terminal.id}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await dragEvent(running.page, a.id, 'dragstart');
        await expect(running.page.locator('.session-activity-card')).toBeHidden();
        await dragEvent(running.page, b.id, 'dragover');
        await expect(running.page.locator('.session-drop-marker')).toHaveCount(1);
        // A real Shell submission promotes Alpha on the Server while the drag geometry stays frozen.
        await pageRequest(running.page, 'terminal.input', {
            terminalId: terminal.id,
            data: 'true\r',
        });
        await expect
            .poll(
                async () =>
                    (
                        await pageRequest<BootstrapState>(running.page, 'app.bootstrap')
                    ).sessions.find((row) => row.id === a.id)?.sessionActivityReason,
            )
            .toBe('user_submission');
        expect(await order()).toEqual([c.id, b.id, a.id]);
        await running.page
            .locator('.project-list')
            .screenshot({ path: testInfo.outputPath('session-drag.png') });
        await dragEvent(running.page, b.id, 'drop', 'after');
        await dragEvent(running.page, a.id, 'dragend');
        await expect.poll(order).toEqual([c.id, b.id, a.id]);
        await expect(running.page.locator('.session-order-announcement')).toContainText(
            'Moved Alpha after Beta',
        );
        // A later activity event legitimately overrides that manual position.
        await pageRequest(running.page, 'terminal.input', {
            terminalId: terminal.id,
            data: 'true\r',
        });
        await expect.poll(order).toEqual([a.id, c.id, b.id]);
        // Keyboard-equivalent move follows the same relative command and keeps selection separate.
        const alpha = running.page.locator(`[data-session-id="${a.id}"]`);
        await alpha.focus();
        await alpha.press('Alt+ArrowDown');
        await expect.poll(order).toEqual([c.id, a.id, b.id]);
        await running.page.locator(`[data-session-id="${b.id}"]`).click();
        await expect.poll(order).toEqual([c.id, a.id, b.id]);
        await running.page
            .locator('.project-list')
            .screenshot({ path: testInfo.outputPath('session-ordered.png') });
        await running.app.close();
        running = await launchCaxri(options);
        await waitForRuntimeReady(running.page);
        await expect.poll(order).toEqual([c.id, a.id, b.id]);
        // Removing a drag source must release its frozen list even when that row cannot deliver dragend anymore.
        await dragEvent(running.page, c.id, 'dragstart');
        await pageRequest(running.page, 'session.archive', { sessionId: c.id });
        const { session: fresh } = await pageRequest<{ session: SessionRecord }>(
            running.page,
            'session.create',
            { projectId: a.projectId, defaultAgent: null },
        );
        await expect.poll(order).toEqual([fresh.id, a.id, b.id]);
        const newSessionIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic creation order for the window boundary
            const { session } = await pageRequest<{ session: SessionRecord }>(
                running.page,
                'session.create',
                { projectId: a.projectId, defaultAgent: null },
            );
            newSessionIds.unshift(session.id);
        }
        /**
         * The capped list already has five rows before the last creation renders. Wait for its actual IDs so a late
         * creation event cannot shift the boundary after capturing the keyboard-move baseline.
         */
        await expect.poll(order).toEqual([...newSessionIds, fresh.id, a.id]);
        const lastVisible = running.page.locator('.session-card').last();
        await expect(running.page.locator('.session-card')).toHaveCount(5);
        const beforeBoundaryMove = await order();
        await lastVisible.focus();
        await lastVisible.press('Alt+ArrowDown');
        await expect(lastVisible).toBeFocused();
        expect(await order()).toEqual(beforeBoundaryMove);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
