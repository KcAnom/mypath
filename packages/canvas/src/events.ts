/** Canvas realtime / domain events recovered from MagicPath client */
export const CanvasEvents = {
  highlightComponents: 'canvas:highlight_components',
  moveShapes: 'move_canvas_shapes',
  createComponent: 'create_component',
  editComponent: 'edit_component',
  patchComponent: 'patch_component',
  removeComponents: 'remove_components',
  insertComponents: 'insert_components',
  clearComponents: 'clear_components',
  revisionCompleted: 'component:revision:completed',
  revisionFailed: 'component:revision:failed',
  insertRevision: 'insert_revision',
  mergeRevisionHistory: 'merge_revision_history',
  updateSelectedRevision: 'update_selected_revision_id',
  instancePresence: 'instance_presence',
  projectUpdate: 'project:update',
  projectCheckComponent: 'project:check:component',
} as const;

export const ThreadEvents = {
  listStreaming: 'list_streaming_threads',
  cancel: 'threads:cancel',
  assistantDelta: 'threads:message:assistant:delta',
  assistantDone: 'threads:message:assistant:done',
  assistantComplete: 'threads:message:assistant:complete',
  assistantCancelled: 'threads:message:assistant:cancelled',
  assistantPartStart: 'threads:message:assistant:part_start',
  reasoningDelta: 'threads:message:assistant:reasoning_delta',
  suggestions: 'threads:message:assistant:suggestions',
  toolUpdate: 'threads:tool:update',
  threadNamed: 'threads:thread:named',
  compactionStatus: 'threads:compaction:status',
  contextUsage: 'threads:context:usage',
} as const;

export const AgentEvents = {
  fileNewLine: 'agent:file:new_line',
  fileSnapshot: 'agent:file:snapshot',
  projectPlan: 'agent:project:plan',
  toolStep: 'agent:tool:step',
} as const;
