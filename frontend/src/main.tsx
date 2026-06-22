import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SapDesk from './SapDesk.tsx'

// Định tuyến theo hash: trang chủ ("/") → màn hình SAP (Agent Desk);
// "#stt" → STT Studio (trang con).
const isStt = () =>
  window.location.hash.replace(/^#\/?/, '').toLowerCase().startsWith('stt')

function Root() {
  const [stt, setStt] = useState(isStt())
  useEffect(() => {
    const onHash = () => setStt(isStt())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return stt ? <App /> : <SapDesk />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
