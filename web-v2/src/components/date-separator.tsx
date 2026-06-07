interface DateSeparatorProps {
  /** ISO date string (e.g. '2024-03-05' or full ISO) */
  date: string
}

/** 在相邻消息日期间插入的分隔条:dashed line + date pill */
export function DateSeparator({ date }: DateSeparatorProps) {
  const d = new Date(date)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  let label: string
  if (formatYMD(d) === formatYMD(today)) {
    label = '今天'
  } else if (formatYMD(d) === formatYMD(yesterday)) {
    label = '昨天'
  } else if (d.getFullYear() === today.getFullYear()) {
    label = `${d.getMonth() + 1}月${d.getDate()}日`
  } else {
    label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div className="my-3 flex items-center gap-2 px-2" data-date-separator>
      <div className="h-px flex-1 border-t border-dashed border-[#45475a]" />
      <span className="rounded-full bg-[#313244] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[.05em] text-[#a6adc8]">
        {label}
      </span>
      <div className="h-px flex-1 border-t border-dashed border-[#45475a]" />
    </div>
  )
}

function formatYMD(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
