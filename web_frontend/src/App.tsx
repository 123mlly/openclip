import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import EditorPage from '@/editor/EditorPage'
import HomePage from '@/pages/HomePage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/editor/:projectId" element={<EditorPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
