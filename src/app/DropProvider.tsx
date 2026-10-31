import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { subscribeToDrops } from "../services/dropService";
import { useNav } from "./NavProvider";
import { usePdf } from "./PdfProvider";
import { useSelection } from "./SelectionProvider";
import { useToast } from "./ToastProvider";
import { useCapabilities } from "./CapabilitiesProvider";
import { operationState } from "../lib/capabilities";

const DropContext = createContext<{ dragging: boolean }>({ dragging: false });

/** Listens for files dropped anywhere on the window. On the PDF editor a dropped file is opened;
 *  on the other screens that take files it joins the shared selection. */
export function DropProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const { route } = useNav();
  const { add } = useSelection();
  const { open } = usePdf();
  const { push } = useToast();
  const { caps } = useCapabilities();
  const canViewPdf = !!caps && operationState(caps, "pdf_view").state === "ready";
  const accepts = route === "dashboard" || route === "compress" || route === "convert" || route === "extract" || route === "pdf-merge" || route === "pdf-split" || route === "images-to-pdf" || route === "pdf-to-images" || route === "office-to-pdf" || (route === "pdf-editor" && canViewPdf);

  useEffect(() => {
    if (!accepts) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    subscribeToDrops((e) => {
      if (e.type === "hover") setDragging(true);
      else if (e.type === "leave") setDragging(false);
      else {
        setDragging(false);
        if (route === "pdf-editor") {
          if (e.paths.length > 1) push("info", "Only one PDF can be open at a time, so the first file was opened.");
          void open(e.paths[0]);
        } else {
          void add(e.paths);
        }
      }
    }).then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [accepts, add, open, push, route]);

  return <DropContext.Provider value={{ dragging: dragging && accepts }}>{children}</DropContext.Provider>;
}

export const useDragging = () => useContext(DropContext).dragging;
