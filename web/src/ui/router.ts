import { useCallback, useEffect, useState } from 'react'

const PAGES = ['dashboard', 'import', 'transactions', 'review', 'settings'] as const
export type Page = (typeof PAGES)[number]

function readHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  return (PAGES as readonly string[]).includes(raw) ? (raw as Page) : 'dashboard'
}

export function useHashPage(): [Page, (page: Page) => void] {
  const [page, setPage] = useState<Page>(readHash)

  useEffect(() => {
    const onChange = (): void => setPage(readHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((next: Page) => {
    window.location.hash = `#/${next}`
    setPage(next)
  }, [])

  return [page, navigate]
}

export function pageTitle(page: Page): string {
  switch (page) {
    case 'dashboard':
      return '消费总览'
    case 'import':
      return '账单导入'
    case 'transactions':
      return '交易明细'
    case 'review':
      return '人工复核'
    case 'settings':
      return '数据与设置'
    default:
      return ''
  }
}