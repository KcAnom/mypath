/** 05-design-systems local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  DESIGN_SYSTEMS: Routes.DESIGN_SYSTEMS as '/design-systems/',
  DESIGN_SYSTEM: Routes.DESIGN_SYSTEM as '/design-systems/:id',
  DESIGN_SYSTEM_DESIGN_MD_PREVIEW: Routes.DESIGN_SYSTEM_DESIGN_MD_PREVIEW as '/design-systems/design-md-preview',
  DESIGN_SYSTEM_DESIGN_MD_PREVIEW_JOB_STATUS: Routes.DESIGN_SYSTEM_DESIGN_MD_PREVIEW_JOB_STATUS as '/design-systems/design-md-preview/:jobId',
  DESIGN_SYSTEM_EXTRACT_FROM_URL: Routes.DESIGN_SYSTEM_EXTRACT_FROM_URL as '/design-systems/extract-from-url',
  DESIGN_SYSTEM_EXTRACT_JOB_STATUS: Routes.DESIGN_SYSTEM_EXTRACT_JOB_STATUS as '/design-systems/extract-from-url/:jobId',
  USER_DESIGN_SYSTEMS: Routes.USER_DESIGN_SYSTEMS as '/users/me/design-systems',
} as const;

export class DesignSystemsService {
  constructor(private api: MyPathApi) {}

  design_system(id: string | number) {
    return this.api.get(this.api.route('DESIGN_SYSTEM', { id }));
  }

  design_systems() {
    return this.api.get(this.api.route('DESIGN_SYSTEMS'));
  }

  design_system_design_md_preview(body?: unknown) {
    return this.api.post(this.api.route('DESIGN_SYSTEM_DESIGN_MD_PREVIEW'), body);
  }

  design_system_design_md_preview_job_status(jobId: string | number, body?: unknown) {
    return this.api.post(this.api.route('DESIGN_SYSTEM_DESIGN_MD_PREVIEW_JOB_STATUS', { jobId }), body);
  }

  design_system_extract_from_url(body?: unknown) {
    return this.api.post(this.api.route('DESIGN_SYSTEM_EXTRACT_FROM_URL'), body);
  }

  design_system_extract_job_status(jobId: string | number, body?: unknown) {
    return this.api.post(this.api.route('DESIGN_SYSTEM_EXTRACT_JOB_STATUS', { jobId }), body);
  }

  user_design_systems() {
    return this.api.get(this.api.route('USER_DESIGN_SYSTEMS'));
  }

}

export function createService(api: MyPathApi) {
  return new DesignSystemsService(api);
}
