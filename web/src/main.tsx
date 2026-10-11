import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app/AppStore'
import { AppShell } from './ui/AppShell'
import './ui/theme.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <AppShell />
    </AppProvider>
  </StrictMode>,
)