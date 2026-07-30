/** 12-assets-media local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  FONTS: Routes.FONTS as '/fonts',
  FONT: Routes.FONT as '/fonts/:id',
  IMAGE_COPY: Routes.IMAGE_COPY as '/images/:id/copy',
  IMAGE_FINALIZE: Routes.IMAGE_FINALIZE as '/images/:id/finalize',
  IMAGE_URL: Routes.IMAGE_URL as '/images/:id/url',
  IMAGES_BATCH: Routes.IMAGES_BATCH as '/images/batch',
  PROJECT_IMAGES: Routes.PROJECT_IMAGES as '/projects/:id/images',
  USER_ASSETS_UPLOAD_URL: Routes.USER_ASSETS_UPLOAD_URL as '/users/me/assets/upload-url',
  USER_FONTS: Routes.USER_FONTS as '/users/me/fonts',
} as const;

export class AssetsMediaService {
  constructor(private api: MyPathApi) {}

  font(id: string | number) {
    return this.api.get(this.api.route('FONT', { id }));
  }

  fonts() {
    return this.api.get(this.api.route('FONTS'));
  }

  images_batch() {
    return this.api.get(this.api.route('IMAGES_BATCH'));
  }

  image_copy(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('IMAGE_COPY', { id }), body);
  }

  image_finalize(id: string | number, body?: unknown) {
    return this.api.post(this.api.route('IMAGE_FINALIZE', { id }), body);
  }

  image_url(id: string | number) {
    return this.api.get(this.api.route('IMAGE_URL', { id }));
  }

  project_images(id: string | number) {
    return this.api.get(this.api.route('PROJECT_IMAGES', { id }));
  }

  user_assets_upload_url() {
    return this.api.get(this.api.route('USER_ASSETS_UPLOAD_URL'));
  }

  user_fonts() {
    return this.api.get(this.api.route('USER_FONTS'));
  }

}

export function createService(api: MyPathApi) {
  return new AssetsMediaService(api);
}
