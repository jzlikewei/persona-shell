import { useState } from 'react'
import { Outlet, NavLink } from 'react-router'
import { MessageSquare, ListTodo, FolderOpen, PanelLeftClose, PanelLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: MessageSquare, label: 'Chat' },
  { to: '/tasks', icon: ListTodo, label: 'Tasks' },
  { to: '/files', icon: FolderOpen, label: 'Files' },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 font-semibold text-lg border-b border-border">
        Persona Shell
      </div>
      <ScrollArea className="flex-1 p-2">
        <nav className="space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </ScrollArea>
    </div>
  )
}

export function RootLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true)

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className={cn(
        'hidden md:flex flex-col border-r border-border bg-sidebar-background transition-all duration-200',
        sidebarOpen ? 'w-60' : 'w-0 overflow-hidden'
      )}>
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      <Sheet>
        <SheetTrigger asChild className="md:hidden absolute top-3 left-3 z-50">
          <Button variant="ghost" size="icon">
            <PanelLeft className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-60">
          <SidebarContent onNavigate={() => {}} />
        </SheetContent>
      </Sheet>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 border-b border-border flex items-center px-4 gap-2 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:flex"
            onClick={() => setSidebarOpen(v => !v)}
          >
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>
          <div className="text-sm text-muted-foreground">persona-shell v2</div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
