/** 04-components local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  COMPONENT: Routes.COMPONENT as '/components/:id',
  COMPONENT_COPY: Routes.COMPONENT_COPY as '/components/:id/copy',
  COMPONENT_COPY_TO_NEW_PROJECT: Routes.COMPONENT_COPY_TO_NEW_PROJECT as '/components/:id/copy-to-new-project',
  COMPONENT_COPY_TO_PROJECT: Routes.COMPONENT_COPY_TO_PROJECT as '/components/:id/copy-to-project',
  COMPONENT_EDIT_ELEMENT: Routes.COMPONENT_EDIT_ELEMENT as '/components/:id/edit-element',
  COMPONENT_FLOW_CHILD: Routes.COMPONENT_FLOW_CHILD as '/components/:id/flow-child',
  COMPONENT_LIKE: Routes.COMPONENT_LIKE as '/components/:id/like',
  COMPONENT_REVISION: Routes.COMPONENT_REVISION as '/components/:id/revision/:revisionId',
  COMPONENT_REVISION_CODE: Routes.COMPONENT_REVISION_CODE as '/components/:id/revision/:revisionId/code',
  COMPONENT_REVISION_DOWNLOAD_KEY: Routes.COMPONENT_REVISION_DOWNLOAD_KEY as '/components/:id/revision/:revisionId/download-key',
  COMPONENT_REVISION_DOWNLOAD_ZIP: Routes.COMPONENT_REVISION_DOWNLOAD_ZIP as '/components/:id/revision/:revisionId/download-zip',
  COMPONENT_REVISION_RETRY: Routes.COMPONENT_REVISION_RETRY as '/components/:id/revision/:revisionId/retry',
  COMPONENT_SCREENSHOT: Routes.COMPONENT_SCREENSHOT as '/components/:id/revision/:revisionId/screenshot',
  COMPONENT_REVISION_VARIATIONS: Routes.COMPONENT_REVISION_VARIATIONS as '/components/:id/revision/:revisionId/variations',
  COMPONENT_REVISIONS: Routes.COMPONENT_REVISIONS as '/components/:id/revisions',
  COMPONENT_REVISIONS_QUEUE: Routes.COMPONENT_REVISIONS_QUEUE as '/components/:id/revisions-queue',
  COMPONENT_REVISION_JOB: Routes.COMPONENT_REVISION_JOB as '/components/:id/revisions/jobs/:jobId',
  COMPONENT_SEND_TO_LIBRARY: Routes.COMPONENT_SEND_TO_LIBRARY as '/components/:id/send-to-library',
  COMPONENT_VISUAL_EDIT_COMMIT: Routes.COMPONENT_VISUAL_EDIT_COMMIT as '/components/:id/visual-edit-commit',
  COMPONENTS_BATCH: Routes.COMPONENTS_BATCH as '/components/batch',
  COMPONENTS_LIKED: Routes.COMPONENTS_LIKED as '/components/liked',
  COMPONENTS_SEND_TO_LIBRARY: Routes.COMPONENTS_SEND_TO_LIBRARY as '/components/send-to-library',
  COMPONENTS_TOP: Routes.COMPONENTS_TOP as '/components/top',
  LIBRARY_COMPONENTS: Routes.LIBRARY_COMPONENTS as '/libraries/:id/components',
  LIBRARY_COMPONENT_COPY_TO_PROJECT: Routes.LIBRARY_COMPONENT_COPY_TO_PROJECT as '/libraries/:id/components/:componentId/copy-to-project',
  PROJECT_COMPONENTS: Routes.PROJECT_COMPONENTS as '/projects/:id/components',
  PROJECT_COMPONENTS_SYNC: Routes.PROJECT_COMPONENTS_SYNC as '/projects/:id/components/sync',
} as const;

export class ComponentsService {
  constructor(private api: MyPathApi) {}

  component(id: string | number) {
    return this.api.get(this.api.route('COMPONENT', { id }));
  }

  components_batch() {
    return this.api.get(this.api.route('COMPONENTS_BATCH'));
  }

  components_liked(body?: unknown) {
    return this.api.post(this.api.route('COMPONENTS_LIKED'), body);
  }

  components_send_to_library(body?: unknown) {
    return this.api.post(this.api.route('COMPONENTS_SEND_TO_LIBRARY'), body);
  }

  components_top() {
    return this.api.get(this.api.route('COMPONENTS_TOP'));
  }

  component_copy(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_COPY', { id }), body);
  }

  component_copy_to_new_project(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_COPY_TO_NEW_PROJECT', { id }), body);
  }

  component_copy_to_project(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_COPY_TO_PROJECT', { id }), body);
  }

  component_edit_element(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_EDIT_ELEMENT', { id }), body);
  }

  component_flow_child(id: string | number) {
    return this.api.get(this.api.route('COMPONENT_FLOW_CHILD', { id }));
  }

  component_like(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_LIKE', { id }), body);
  }

  component_revision(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION', { id, revisionId }));
  }

  component_revisions(id: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISIONS', { id }));
  }

  component_revisions_queue(id: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISIONS_QUEUE', { id }));
  }

  component_revision_code(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION_CODE', { id, revisionId }));
  }

  component_revision_download_key(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION_DOWNLOAD_KEY', { id, revisionId }));
  }

  component_revision_download_zip(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION_DOWNLOAD_ZIP', { id, revisionId }));
  }

  component_revision_job(id: string | number, jobId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION_JOB', { id, jobId }));
  }

  component_revision_retry(id: string | number, revisionId: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_REVISION_RETRY', { id, revisionId }), body);
  }

  component_revision_variations(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_REVISION_VARIATIONS', { id, revisionId }));
  }

  component_screenshot(id: string | number, revisionId: string | number) {
    return this.api.get(this.api.route('COMPONENT_SCREENSHOT', { id, revisionId }));
  }

  component_send_to_library(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_SEND_TO_LIBRARY', { id }), body);
  }

  component_visual_edit_commit(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_VISUAL_EDIT_COMMIT', { id }), body);
  }

  library_components(id: string | number) {
    return this.api.get(this.api.route('LIBRARY_COMPONENTS', { id }));
  }

  library_component_copy_to_project(id: string | number, componentId: string | number, body?: unknown) {
    return this.api.post(this.api.route('LIBRARY_COMPONENT_COPY_TO_PROJECT', { id, componentId }), body);
  }

  project_components(id: string | number) {
    return this.api.get(this.api.route('PROJECT_COMPONENTS', { id }));
  }

  project_components_sync(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_COMPONENTS_SYNC', { id }), body);
  }

}

export function createService(api: MyPathApi) {
  return new ComponentsService(api);
}
