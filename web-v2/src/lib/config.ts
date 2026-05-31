const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin

export const config = {
  apiBase,
  wsBase: apiBase.replace(/^http/, 'ws'),
}
