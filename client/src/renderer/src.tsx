import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import '@fontsource/libre-franklin/500.css'
import '@fontsource/libre-franklin/600.css'
import '@fontsource/libre-franklin/700.css'
import '@fontsource/newsreader/500.css'
import '@fontsource/newsreader/600.css'

import { App } from './App'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Không tìm thấy vùng gốc React')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
