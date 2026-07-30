/** 08-chat-agents local service */
import { Routes, fillRoute } from '../../shared/src/routes';
import { MyPathApi } from './api-client';

export const ModuleRoutes = {
  USER_CHAT_THREADS: Routes.USER_CHAT_THREADS as '/users/me/chat-threads',
  USER_CHAT_THREAD: Routes.USER_CHAT_THREAD as '/users/me/chat-threads/:threadId',
  USER_CHAT_THREAD_MESSAGES: Routes.USER_CHAT_THREAD_MESSAGES as '/users/me/chat-threads/:threadId/messages',
} as const;

export class ChatAgentsService {
  constructor(private api: MyPathApi) {}

  user_chat_thread(threadId: string | number) {
    return this.api.get(this.api.route('USER_CHAT_THREAD', { threadId }));
  }

  user_chat_threads() {
    return this.api.get(this.api.route('USER_CHAT_THREADS'));
  }

  user_chat_thread_messages(threadId: string | number) {
    return this.api.get(this.api.route('USER_CHAT_THREAD_MESSAGES', { threadId }));
  }

}

export function createService(api: MyPathApi) {
  return new ChatAgentsService(api);
}
