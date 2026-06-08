// 便利 re-export: 把 ToastViewport 导出为 <Toaster /> 这种更通用的名字
// 供 App.tsx 等地方用 <Toaster /> 挂一次
export { ToastProvider, useToast, type ToastInput, type ToastEntry, type ToastTone } from '@/hooks/use-toast.tsx'
export { ToastViewport as Toaster } from './toast-viewport'
