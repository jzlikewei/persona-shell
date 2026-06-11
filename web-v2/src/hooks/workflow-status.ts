import type { ChatWorkflow } from './use-chat'

export function turnStatusFromGoalStatus(status?: string): ChatWorkflow['turnStatus'] | undefined {
  const normalized = status?.toLowerCase().replace(/[\s_-]/g, '')
  if (!normalized) return undefined
  if (['complete', 'completed', 'done'].includes(normalized)) return 'completed'
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed'
  if (normalized === 'blocked') return 'blocked'
  if (['active', 'running', 'inprogress', 'inflight'].includes(normalized)) return 'running'
  return undefined
}

export function isWorkflowActive(workflow?: ChatWorkflow | null) {
  return workflow?.turnStatus === 'running'
}
