import { BrowserRouter, Routes, Route } from "react-router"

import QueryPage from "@/pages/query"
import ArticlePage from "@/pages/article"

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<QueryPage />} />
        <Route path="/wiki/:slug" element={<ArticlePage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
