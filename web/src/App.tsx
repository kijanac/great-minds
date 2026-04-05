import { BrowserRouter, Routes, Route } from "react-router"

import HomePage from "@/pages/home"
import ArticlePage from "@/pages/article"
import SessionPage from "@/pages/session"
import SessionsPage from "@/pages/sessions"

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/wiki/:slug" element={<ArticlePage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
