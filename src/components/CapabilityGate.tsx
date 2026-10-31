import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { OperationReport } from "../lib/types";
import { operationState } from "../lib/capabilities";
import { useCapabilities } from "../app/CapabilitiesProvider";
import { Callout } from "./Callout";
import { Button } from "./Button";
import { Card } from "./Card";

/** Shows a workflow only when the backend reports the operation as available;
 *  otherwise says why, so nothing is offered that cannot run. */
export function CapabilityGate({ operationId, children }: { operationId: string; children: (op: OperationReport) => ReactNode }) {
  const { state, reload } = useCapabilities();
  if (state.status === "loading") {
    return (
      <Card>
        <p role="status" className="gate-note">
          Checking what OrangeFile can do on this computer…
        </p>
      </Card>
    );
  }
  if (state.status === "error") {
    return (
      <Callout tone="error" title="Couldn't load the list of supported operations">
        <p>{state.message}</p>
        <Button size="sm" icon={<RefreshCw size={15} aria-hidden />} onClick={reload} className="gate-retry">
          Try again
        </Button>
      </Callout>
    );
  }
  const op = operationState(state.caps, operationId);
  if (op.state !== "ready") {
    return (
      <Callout tone="warning" title={op.state === "unavailable" ? "This tool isn't available right now" : "Coming later"}>
        {op.reason}
      </Callout>
    );
  }
  return <>{children(op.op)}</>;
}
