import { useCallback } from 'react'
import { config } from '@/lib/config'

interface FetchOptions extends RequestInit {
  params?: Record<string, string>
}

export function useApi() {
  const request = useCallback(async <T = unknown>(path: string, options: FetchOptions = {}): Promise<T> => {
    const { params, ...init } = options
    const url = new URL(path, config.apiBase)
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
    }

    const token = localStorage.getItem('auth_token') || ''
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const res = await fetch(url.toString(), { ...init, headers })
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
    return res.json()
  }, [])

  const get = useCallback(<T = unknown>(path: string, params?: Record<string, string>) =>
    request<T>(path, { params }), [request])

  const post = useCallback(<T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }), [request])

  return { request, get, post }
}
