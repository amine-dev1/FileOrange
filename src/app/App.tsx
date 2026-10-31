import { AppShell } from "../components/AppShell";
import { CompressPage } from "../features/compress/CompressPage";
import { ConvertPage } from "../features/convert/ConvertPage";
import { Dashboard } from "../features/dashboard/Dashboard";
import { ExtractPage } from "../features/extract/ExtractPage";
import { FormatsPage } from "../features/formats/FormatsPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { NoticesPage } from "../features/notices/NoticesPage";
import { MergePage } from "../features/pdf/MergePage";
import { SplitPage } from "../features/pdf/SplitPage";
import { ImagesToPdfPage } from "../features/pdf/ImagesToPdfPage";
import { PdfToImagesPage } from "../features/pdf/PdfToImagesPage";
import { OfficeToPdfPage } from "../features/pdf/OfficeToPdfPage";
import { PdfEditorPage } from "../features/pdf/PdfEditorPage";
import { PdfToolsPage } from "../features/pdf/PdfToolsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { CapabilitiesProvider } from "./CapabilitiesProvider";
import { DropProvider } from "./DropProvider";
import { JobsProvider } from "./JobsProvider";
import { NavProvider, useNav } from "./NavProvider";
import { PdfProvider } from "./PdfProvider";
import { SelectionProvider } from "./SelectionProvider";
import { ServiceBanner } from "./ServiceBanner";
import { SettingsProvider } from "./SettingsProvider";
import { ToastProvider } from "./ToastProvider";

function Screen() {
  const { route } = useNav();
  switch (route) {
    case "dashboard":
      return <Dashboard />;
    case "convert":
      return <ConvertPage />;
    case "pdf-tools":
      return <PdfToolsPage />;
    case "pdf-editor":
      return <PdfEditorPage />;
    case "pdf-merge":
      return <MergePage />;
    case "pdf-split":
      return <SplitPage />;
    case "images-to-pdf":
      return <ImagesToPdfPage />;
    case "pdf-to-images":
      return <PdfToImagesPage />;
    case "office-to-pdf":
      return <OfficeToPdfPage />;
    case "compress":
      return <CompressPage />;
    case "extract":
      return <ExtractPage />;
    case "jobs":
      return <JobsPage />;
    case "settings":
      return <SettingsPage />;
    case "formats":
      return <FormatsPage />;
    case "notices":
      return <NoticesPage />;
  }
}

export function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <NavProvider>
          <CapabilitiesProvider>
            <SelectionProvider>
              <PdfProvider>
                <DropProvider>
                  <JobsProvider>
                    <AppShell>
                      <ServiceBanner />
                      <Screen />
                    </AppShell>
                  </JobsProvider>
                </DropProvider>
              </PdfProvider>
            </SelectionProvider>
          </CapabilitiesProvider>
        </NavProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
