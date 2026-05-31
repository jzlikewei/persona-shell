import { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router'
import { RootLayout } from '@/layouts/root-layout'
import { ChatPage } from '@/pages/chat'
import { TasksPage } from '@/pages/tasks'
import { FilesPage } from '@/pages/files'
import { TokenDialog } from '@/components/token-dialog'

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem('auth_token'))

  return (
    <>
      <TokenDialog onAuthenticated={() => setAuthenticated(true)} />
      {authenticated && (
        <BrowserRouter>
          <Routes>
            <Route element={<RootLayout />}>
              <Route index element={<ChatPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="files" element={<FilesPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )}
    </>
  )
}
