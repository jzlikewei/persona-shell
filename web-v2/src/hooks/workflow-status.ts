import type { ChatWorkflow } from './use-chat'

function normalizeStatus(status?: string) {
  return status?.toLowerCase().replace(/[\s_-]/g, '')
}

export function turnStatusFromGoalStatus(status?: string): ChatWorkflow['turnStatus'] | undefined {
  const normalized = normalizeStatus(status)
  if (!normalized) return undefined
  if (['complete', 'completed', 'done'].includes(normalized)) return 'completed'
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed'
  if (normalized === 'blocked') return 'blocked'
  if (['active', 'running', 'inprogress', 'inflight'].includes(normalized)) return 'running'
  return undefined
}

export function isGoalCompletedStatus(status?: string) {
  const normalized = normalizeStatus(status)
  return normalized ? ['complete', 'completed', 'done'].includes(normalized) : false
}

export function isWorkflowActive(workflow?: ChatWorkflow | null) {
  return workflow?.turnStatus === 'running'
}
