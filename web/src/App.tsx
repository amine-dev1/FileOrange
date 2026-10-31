import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { About } from "./pages/About";
import { CompressPage } from "./pages/Compress";
import { ConvertPage } from "./pages/Convert";
import { Dashboard } from "./pages/Dashboard";
import { ExtractPage } from "./pages/Extract";
import { ImagesToPdfPage } from "./pages/ImagesToPdf";
import { JobsPage } from "./pages/Jobs";
import { MergePage } from "./pages/Merge";
import { NotFound } from "./pages/NotFound";
import { OfficeToPdfPage } from "./pages/OfficeToPdf";
import { PdfHub } from "./pages/PdfHub";
import { PdfToImagesPage } from "./pages/PdfToImages";
import { SplitPage } from "./pages/Split";
import { Landing } from "./pages/landing/Landing";

// The editor is the largest screen and not everyone opens it, so it loads on demand.
const PdfEditorPage = lazy(() => import("./pages/editor/PdfEditorPage"));

export function App() {
  return (
    <Routes>
      <Route index element={<Landing />} />
      <Route element={<AppShell />}>
        <Route path="app" element={<Dashboard />} />
        <Route path="convert" element={<ConvertPage />} />
        <Route path="compress" element={<CompressPage />} />
        <Route path="extract" element={<ExtractPage />} />
        <Route path="pdf" element={<PdfHub />} />
        <Route
          path="pdf/editor"
          element={
            <Suspense
              fallback={
                <p role="status" className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-400">
                  <Spinner /> Loading the editor…
                </p>
              }
            >
              <PdfEditorPage />
            </Suspense>
          }
        />
        <Route path="pdf/merge" element={<MergePage />} />
        <Route path="pdf/split" element={<SplitPage />} />
        <Route path="pdf/images-to-pdf" element={<ImagesToPdfPage />} />
        <Route path="pdf/to-images" element={<PdfToImagesPage />} />
        <Route path="pdf/documents-to-pdf" element={<OfficeToPdfPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="about" element={<About />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
