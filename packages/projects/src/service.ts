/** 03-projects local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  PROJECTS: Routes.PROJECTS as '/projects',
  PROJECT: Routes.PROJECT as '/projects/:id',
  PROJECT_COMPONENTS: Routes.PROJECT_COMPONENTS as '/projects/:id/components',
  PROJECT_COMPONENTS_SYNC: Routes.PROJECT_COMPONENTS_SYNC as '/projects/:id/components/sync',
  PROJECT_CONTEXT: Routes.PROJECT_CONTEXT as '/projects/:id/context',
  PROJECT_COPY: Routes.PROJECT_COPY as '/projects/:id/copy',
  PROJECT_IMAGES: Routes.PROJECT_IMAGES as '/projects/:id/images',
  PROJECT_LEAVE: Routes.PROJECT_LEAVE as '/projects/:id/leave',
  PROJECT_MAKE_SHARED: Routes.PROJECT_MAKE_SHARED as '/projects/:id/make-shared',
  PROJECT_MEMBER: Routes.PROJECT_MEMBER as '/projects/:id/members/:userId',
  PROJECT_MOVE_TO_ORGANIZATION: Routes.PROJECT_MOVE_TO_ORGANIZATION as '/projects/:id/move-to-organization',
  PROJECT_OPEN: Routes.PROJECT_OPEN as '/projects/:id/open',
  PROJECT_SHARE: Routes.PROJECT_SHARE as '/projects/:id/share',
  PROJECTS_POPULAR: Routes.PROJECTS_POPULAR as '/projects/popular',
  PROJECTS_PUBLIC: Routes.PROJECTS_PUBLIC as '/projects/public',
  PROJECTS_TOP_VIEWED: Routes.PROJECTS_TOP_VIEWED as '/projects/top-viewed',
} as const;

export class ProjectsService {
  constructor(private api: MyPathApi) {}

  project(id: string | number) {
    return this.api.get(this.api.route('PROJECT', { id }));
  }

  projects() {
    return this.api.get(this.api.route('PROJECTS'));
  }

  projects_popular() {
    return this.api.get(this.api.route('PROJECTS_POPULAR'));
  }

  projects_public() {
    return this.api.get(this.api.route('PROJECTS_PUBLIC'));
  }

  projects_top_viewed() {
    return this.api.get(this.api.route('PROJECTS_TOP_VIEWED'));
  }

  project_components(id: string | number) {
    return this.api.get(this.api.route('PROJECT_COMPONENTS', { id }));
  }

  project_components_sync(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_COMPONENTS_SYNC', { id }), body);
  }

  project_context(id: string | number) {
    return this.api.get(this.api.route('PROJECT_CONTEXT', { id }));
  }

  project_copy(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_COPY', { id }), body);
  }

  project_images(id: string | number) {
    return this.api.get(this.api.route('PROJECT_IMAGES', { id }));
  }

  project_leave(id: string | number) {
    return this.api.get(this.api.route('PROJECT_LEAVE', { id }));
  }

  project_make_shared(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_MAKE_SHARED', { id }), body);
  }

  project_member(id: string | number, userId: string | number) {
    return this.api.get(this.api.route('PROJECT_MEMBER', { id, userId }));
  }

  project_move_to_organization(id: string | number) {
    return this.api.get(this.api.route('PROJECT_MOVE_TO_ORGANIZATION', { id }));
  }

  project_open(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_OPEN', { id }), body);
  }

  project_share(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('PROJECT_SHARE', { id }), body);
  }

}

export function createService(api: MyPathApi) {
  return new ProjectsService(api);
}
