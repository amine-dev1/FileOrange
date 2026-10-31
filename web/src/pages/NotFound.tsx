import { Link } from "react-router-dom";
import { PageHeader } from "../components/ToolShell";

export function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" subtitle="That address doesn't match anything here." />
      <Link to="/" className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
        Go to the dashboard
      </Link>
    </>
  );
}
