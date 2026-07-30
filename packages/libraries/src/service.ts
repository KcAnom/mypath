/** 06-libraries local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  COMPONENT_SEND_TO_LIBRARY: Routes.COMPONENT_SEND_TO_LIBRARY as '/components/:id/send-to-library',
  COMPONENTS_SEND_TO_LIBRARY: Routes.COMPONENTS_SEND_TO_LIBRARY as '/components/send-to-library',
  LIBRARIES: Routes.LIBRARIES as '/libraries/',
  LIBRARY: Routes.LIBRARY as '/libraries/:id',
  LIBRARY_ACTIVE: Routes.LIBRARY_ACTIVE as '/libraries/:id/active',
  LIBRARY_COMPONENTS: Routes.LIBRARY_COMPONENTS as '/libraries/:id/components',
  LIBRARY_COMPONENT_COPY_TO_PROJECT: Routes.LIBRARY_COMPONENT_COPY_TO_PROJECT as '/libraries/:id/components/:componentId/copy-to-project',
  LIBRARY_COPY: Routes.LIBRARY_COPY as '/libraries/:id/copy',
  LIBRARY_INSTALL: Routes.LIBRARY_INSTALL as '/libraries/:id/install',
  LIBRARY_PROMOTE_DEFAULT: Routes.LIBRARY_PROMOTE_DEFAULT as '/libraries/:id/promote-default',
} as const;

export class LibrariesService {
  constructor(private api: MyPathApi) {}

  components_send_to_library(body?: unknown) {
    return this.api.post(this.api.route('COMPONENTS_SEND_TO_LIBRARY'), body);
  }

  component_send_to_library(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('COMPONENT_SEND_TO_LIBRARY', { id }), body);
  }

  libraries() {
    return this.api.get(this.api.route('LIBRARIES'));
  }

  library(id: string | number) {
    return this.api.get(this.api.route('LIBRARY', { id }));
  }

  library_active(id: string | number) {
    return this.api.get(this.api.route('LIBRARY_ACTIVE', { id }));
  }

  library_components(id: string | number) {
    return this.api.get(this.api.route('LIBRARY_COMPONENTS', { id }));
  }

  library_component_copy_to_project(id: string | number, componentId: string | number, body?: unknown) {
    return this.api.post(this.api.route('LIBRARY_COMPONENT_COPY_TO_PROJECT', { id, componentId }), body);
  }

  library_copy(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('LIBRARY_COPY', { id }), body);
  }

  library_install(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('LIBRARY_INSTALL', { id }), body);
  }

  library_promote_default(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('LIBRARY_PROMOTE_DEFAULT', { id }), body);
  }

}

export function createService(api: MyPathApi) {
  return new LibrariesService(api);
}
