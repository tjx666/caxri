import type {
    ExtensionCapability,
    ExtensionManifest,
    ExtensionViewChange,
    ExtensionViewEventContext,
    ProjectStatusSummary,
} from '../../packages/protocol/src';

export type ExtensionProjectStatusSummary = Omit<ProjectStatusSummary, 'repositories'> & {
    repositories: Array<Omit<ProjectStatusSummary['repositories'][number], 'rootPath'>>;
};

export const MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH = 200;

export const extensionWorkspaceOperations = [
    'files.list',
    'files.search',
    'files.create',
    'files.copy',
    'files.rename',
    'files.move',
    'files.operation.get',
    'files.operation.list',
    'files.operation.cancel',
    'files.operation.acknowledge',
    'files.trash',
    'files.reveal',
    'git.summary',
    'git.sync',
    'git.discard',
    'git.pullRequestChanges',
    'git.commits',
    'git.commitDetails',
    'git.remoteHost',
] as const;

export type ExtensionWorkspaceOperation = (typeof extensionWorkspaceOperations)[number];

export type ExtensionFilesChange =
    { kind: 'content'; paths?: string[]; overflow?: boolean } | { kind: 'operation' };

export interface ExtensionHostRegistration {
    extensionId: string;
    generation: number;
    apiToken: string;
    rootPath: string;
    entryPath: string;
    manifest: ExtensionManifest;
    grants: ExtensionCapability[];
    projectIds: string[];
}

export type ExtensionViewEventScope = ExtensionViewEventContext;

export type ExtensionHostRequest =
    | {
          id: string;
          method: 'configure';
          params: { extensions: ExtensionHostRegistration[] };
      }
    | {
          id: string;
          method: 'activate';
          params: { extensionId: string; generation: number; reason: string };
      }
    | {
          id: string;
          method: 'treeChildren';
          params: {
              extensionId: string;
              generation: number;
              viewId: string;
              parentHandle?: string;
              requestId: string;
              context?: ExtensionViewEventScope;
          };
      }
    | {
          id: string;
          method: 'executeCommand';
          params: {
              extensionId: string;
              generation: number;
              commandId: string;
              arguments: unknown[];
              context: ExtensionViewEventScope;
          };
      }
    | {
          id: string;
          method: 'viewOperation';
          params: {
              extensionId: string;
              generation: number;
              viewId: string;
              operation: ExtensionWorkspaceOperation;
              arguments: unknown;
              requestId: string;
              context: ExtensionViewEventScope;
          };
      }
    | {
          id: string;
          method: 'activeContextChanged';
          params: { context: ExtensionViewEventScope };
      }
    | {
          id: string;
          method: 'filesChanged';
          params: { change: ExtensionFilesChange; context: ExtensionViewEventScope };
      }
    | {
          id: string;
          method: 'gitChanged';
          params: { context: ExtensionViewEventScope };
      }
    | {
          id: string;
          method: 'projectStatusChanged';
          params: { context: ExtensionViewEventScope };
      }
    | { id: string; method: 'cancel'; params: { requestId: string } }
    | { id: string; method: 'shutdown'; params: Record<string, never> };

interface ExtensionHostApiRequestBase {
    type: 'api-request';
    id: string;
    extensionId: string;
    generation: number;
    apiToken: string;
}

export type ExtensionHostApiRequest = ExtensionHostApiRequestBase &
    (
        | {
              method: 'workspace.getProjectStatus';
              params: { refreshToken?: string };
          }
        | {
              method: 'workspace.request';
              params: { operation: ExtensionWorkspaceOperation; arguments: unknown };
          }
    );

export type ExtensionHostMessage =
    | ExtensionHostApiRequest
    | { type: 'api-cancel'; id: string }
    | { type: 'ready' }
    | { type: 'reply'; id: string; ok: true; result: unknown }
    | {
          type: 'reply';
          id: string;
          ok: false;
          error: { code: string; message: string };
      }
    | {
          type: 'event';
          event: 'treeChanged';
          extensionId: string;
          generation: number;
          viewId: string;
          eventId: string;
          context: ExtensionViewEventScope;
          handles?: string[];
      }
    | {
          type: 'event';
          event: 'viewChanged';
          extensionId: string;
          generation: number;
          viewId: string;
          eventId: string;
          context: ExtensionViewEventScope;
          change: ExtensionViewChange;
      };

export type ExtensionHostParentMessage =
    | ExtensionHostRequest
    | {
          type: 'api-reply';
          id: string;
          ok: true;
          result: unknown;
      }
    | {
          type: 'api-reply';
          id: string;
          ok: false;
          error: { code: string; message: string };
      };
