import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { CapabilitiesProvider } from "./state/CapabilitiesProvider";
import { DropProvider } from "./state/DropProvider";
import { EditorProvider } from "./state/EditorProvider";
import { JobsProvider } from "./state/JobsProvider";
import { SelectionProvider } from "./state/SelectionProvider";
import { ThemeProvider } from "./state/ThemeProvider";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <CapabilitiesProvider>
        <SelectionProvider>
          <JobsProvider>
            <EditorProvider>
              <DropProvider>
                <BrowserRouter>
                  <App />
                </BrowserRouter>
              </DropProvider>
            </EditorProvider>
          </JobsProvider>
        </SelectionProvider>
      </CapabilitiesProvider>
    </ThemeProvider>
  </StrictMode>,
);
