import type { UploadFile } from "./api";
import { uploadName, type FileItem } from "./files";

export { titleFor, withExtension } from "./names";

export const toUploads = (items: FileItem[]): UploadFile[] => items.map((i) => ({ file: i.file, name: uploadName(i) }));
