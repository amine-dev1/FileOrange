import { useMemo } from "react";
import type { PathInfo } from "../../lib/types";
import type { FileRow } from "../../components/FileList";
import { formatForFileName, labels } from "../../lib/capabilities";
import { useCapabilities } from "../../app/CapabilitiesProvider";

/** Which of the shared selection the operation can read, and why not. Uses the
 *  operation's real input list; operations that accept anything have none. */
export function useWorkflowRows(operationId: string, items: PathInfo[]) {
  const { caps } = useCapabilities();
  return useMemo(() => {
    const op = caps?.operations.find((o) => o.id === operationId);
    const rows: FileRow[] = items.map((info) => {
      let problem: string | undefined;
      if (caps && op && op.inputs.length > 0) {
        const fmt = info.is_dir ? null : formatForFileName(caps, info.name);
        if (info.is_dir) problem = "Folders can't be used here. Remove it to continue.";
        else if (!fmt || !op.inputs.includes(fmt.id)) problem = `Not a supported file (${labels(caps, op.inputs)}). Remove it to continue.`;
      }
      return { info, problem };
    });
    return { rows, valid: rows.length > 0 && rows.every((r) => !r.problem) };
  }, [caps, operationId, items]);
}
