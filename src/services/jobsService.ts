import { call } from "../lib/tauri";
import type {
  ApiStatus,
  Capabilities,
  ArchiveListing,
  DesktopStatus,
  DownloadSummary,
  JobRequest,
  PathInfo,
  Review,
} from "../lib/types";

/** Typed wrappers over the Tauri commands in src-tauri/src/commands.rs. */
export const jobsService = {
  apiStatus: () => call<ApiStatus>("api_status"),
  /** What this build can really do: engines, operations, conversion pairs, options, limits. */
  capabilities: () => call<Capabilities>("get_capabilities"),
  inspectPaths: (paths: string[]) => call<PathInfo[]>("inspect_paths", { paths }),
  listArchive: (path: string) => call<ArchiveListing>("list_archive", { path }),
  /** Dry run: conflicts, warnings and blocking problems. Writes nothing. */
  review: (request: JobRequest) => call<Review>("review_job", { request }),
  start: (request: JobRequest) => call<string>("start_job", { request }),
  status: (jobId: string) => call<DesktopStatus>("get_job_status", { jobId }),
  cancel: (jobId: string) => call<void>("cancel_job", { jobId }),
  download: (jobId: string) => call<DownloadSummary>("download_result", { jobId }),
  reveal: (path: string) => call<void>("reveal_output", { path }),
  clearBackendHistory: () => call<void>("clear_history"),
};
