import { Link } from 'react-router'
import { Compass } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Compass className="size-5" />
            <span className="font-mono text-xs uppercase tracking-[.08em]">404</span>
          </div>
          <CardTitle className="mt-2 text-xl">页面找不到了</CardTitle>
          <CardDescription>
            你访问的路径不存在,或者已经被移动到别处。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/">回到 Chat</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
