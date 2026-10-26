import type { CommandDefinition } from '../command-catalog.js';

/**
 * Branch and review-comment navigation commands of the Git surfaces, listed last in the command catalog.
 */
export const gitCommandDefinitions: CommandDefinition[] = [
    {
        id: 'git.switchBranch',
        title: 'Switch Branch…',
        category: 'Git',
        description: "Check out another branch in the selected Session's repository",
        keywords: ['checkout', 'git'],
    },
    {
        id: 'git.goToNextReviewComment',
        title: 'Go to Next Review Comment',
        category: 'Git',
        description: 'Jump to the next review comment anchored in the active Git diff tab',
        keywords: ['diff', 'comment', 'review', 'next'],
    },
    {
        id: 'git.goToPreviousReviewComment',
        title: 'Go to Previous Review Comment',
        category: 'Git',
        description: 'Jump to the previous review comment anchored in the active Git diff tab',
        keywords: ['diff', 'comment', 'review', 'previous'],
    },
    {
        id: 'git.showPendingReviewComments',
        title: 'Show Pending Review Comments',
        category: 'Git',
        description: 'Open the repository with pending review comments and reveal them',
        keywords: ['diff', 'comment', 'review', 'pending'],
    },
];
