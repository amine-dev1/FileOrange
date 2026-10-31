import { FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder, File as FileGeneric } from "lucide-react";
import { extensionOf } from "../lib/format";
import { formatForFileName } from "../lib/capabilities";
import { useCapabilities } from "../app/CapabilitiesProvider";

/** Small coloured file glyph keyed on what the format catalog says the file is. */
export function FileTypeIcon({ name, isDir = false, size = 24 }: { name: string; isDir?: boolean; size?: number }) {
  const { caps } = useCapabilities();
  const props = { size, "aria-hidden": true, strokeWidth: 1.75 } as const;
  if (isDir) return <Folder {...props} color="#d9822b" fill="#fde7cf" />;
  const kind = (caps && formatForFileName(caps, name)?.kind) ?? (extensionOf(name) === "pdf" ? "pdf" : null);
  switch (kind) {
    case "archive":
      return <FileArchive {...props} color="#6b7280" />;
    case "image":
      return <FileImage {...props} color="#1a8f52" />;
    case "pdf":
      return <FileText {...props} color="#d9362e" />;
    case "audio":
      return <FileAudio {...props} color="#7c5cd6" />;
    case "video":
      return <FileVideo {...props} color="#2b7de9" />;
    default:
      return <FileGeneric {...props} color="#6b7280" />;
  }
}
