/** 09-skills local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  SKILL: Routes.SKILL as '/skills/:id',
  SKILL_FILES: Routes.SKILL_FILES as '/skills/:id/files',
  SKILL_FILE_CONTENT: Routes.SKILL_FILE_CONTENT as '/skills/:id/files/content',
  USER_SKILLS: Routes.USER_SKILLS as '/users/me/skills',
  USER_SKILLS_IMPORT: Routes.USER_SKILLS_IMPORT as '/users/me/skills/import',
} as const;

export class SkillsService {
  constructor(private api: MyPathApi) {}

  skill(id: string | number) {
    return this.api.get(this.api.route('SKILL', { id }));
  }

  skill_files(id: string | number) {
    return this.api.get(this.api.route('SKILL_FILES', { id }));
  }

  skill_file_content(id: string | number) {
    return this.api.get(this.api.route('SKILL_FILE_CONTENT', { id }));
  }

  user_skills() {
    return this.api.get(this.api.route('USER_SKILLS'));
  }

  user_skills_import(body?: unknown) {
    return this.api.post(this.api.route('USER_SKILLS_IMPORT'), body);
  }

}

export function createService(api: MyPathApi) {
  return new SkillsService(api);
}
