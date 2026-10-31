import { ArrowDown, ArrowUp, Combine, Copy, FileOutput, FilePlus, FormInput, Highlighter, ImagePlus, Layers, MessageSquare, PenLine, Pencil, RotateCcw, RotateCw, Shapes, Split, Strikethrough, Trash2, Type, Underline, type LucideIcon } from "lucide-react";

export interface EditorTool {
  /** Names the action in the editor that this button runs. */
  key: string;
  /** Backend operation id that must be available for this tool to work. */
  opId: string;
  label: string;
  Icon: LucideIcon;
  note?: string;
}

export interface EditorToolGroup {
  title: string;
  tools: EditorTool[];
}

/** The editor's planned tools, grouped as on screen. Whether each works is decided by the capability report. */
export const EDITOR_TOOL_GROUPS: EditorToolGroup[] = [
  {
    title: "Pages",
    tools: [
      { key: "rotate-left", opId: "pdf_rotate", label: "Rotate left", Icon: RotateCcw },
      { key: "rotate-right", opId: "pdf_rotate", label: "Rotate right", Icon: RotateCw },
      { key: "move-earlier", opId: "pdf_reorder", label: "Move earlier", Icon: ArrowUp },
      { key: "move-later", opId: "pdf_reorder", label: "Move later", Icon: ArrowDown },
      { key: "delete", opId: "pdf_delete_pages", label: "Delete", Icon: Trash2 },
      { key: "extract", opId: "pdf_extract_pages", label: "Extract…", Icon: FileOutput },
      { key: "split", opId: "pdf_split", label: "Split…", Icon: Split },
      { key: "merge", opId: "pdf_merge", label: "Merge…", Icon: Combine },
      { key: "duplicate", opId: "pdf_duplicate_pages", label: "Duplicate", Icon: Copy },
      { key: "insert", opId: "pdf_insert_pages", label: "Insert pages", Icon: FilePlus },
    ],
  },
  {
    title: "Annotate",
    tools: [
      { key: "highlight", opId: "pdf_annotate", label: "Highlight", Icon: Highlighter },
      { key: "underline", opId: "pdf_annotate", label: "Underline", Icon: Underline },
      { key: "strikethrough", opId: "pdf_annotate", label: "Strikethrough", Icon: Strikethrough },
      { key: "comment", opId: "pdf_annotate", label: "Comment", Icon: MessageSquare },
      { key: "draw", opId: "pdf_annotate", label: "Draw", Icon: Pencil },
      { key: "shapes", opId: "pdf_annotate", label: "Shapes", Icon: Shapes },
      { key: "text-box", opId: "pdf_annotate", label: "Text box", Icon: Type },
      { key: "image", opId: "pdf_annotate", label: "Image", Icon: ImagePlus },
    ],
  },
  {
    title: "Sign",
    tools: [{ key: "visual-signature", opId: "pdf_annotate", label: "Visual signature", Icon: PenLine, note: "A drawn picture on the page. Not a verified digital signature." }],
  },
  {
    title: "Forms",
    tools: [
      { key: "fill-form", opId: "pdf_fill_form", label: "Fill form", Icon: FormInput },
      { key: "flatten-form", opId: "pdf_flatten_form", label: "Flatten form", Icon: Layers, note: "Makes the fields permanent. They can no longer be edited." },
    ],
  },
];

