import type {
    ExtensionCapability,
    ExtensionManifest,
    ProjectStatusSummary,
} from '../../packages/protocol/src';

export type ExtensionProjectStatusSummary = Omit<ProjectStatusSummary, 'repositories'> & {
    repositories: Array<Omit<ProjectStatusSummary['repositories'][number], 'rootPath'>>;
};

export const MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH = 200;

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
          };
      }
    | { id: string; method: 'activeContextChanged'; params: Record<string, never> }
    | { id: string; method: 'projectStatusChanged'; params: Record<string, never> }
    | { id: string; method: 'cancel'; params: { requestId: string } }
    | { id: string; method: 'shutdown'; params: Record<string, never> };

export interface ExtensionHostApiRequest {
    type: 'api-request';
    id: string;
    extensionId: string;
    generation: number;
    apiToken: string;
    method: 'workspace.getProjectStatus';
    params: { refreshToken?: string };
}

export type ExtensionHostMessage =
    | ExtensionHostApiRequest
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
          handles?: string[];
      };

export type ExtensionHostParentMessage =
    | ExtensionHostRequest
    | {
          type: 'api-reply';
          id: string;
          ok: true;
          result: ExtensionProjectStatusSummary;
      }
    | {
          type: 'api-reply';
          id: string;
          ok: false;
          error: { code: string; message: string };
      };
