import { Link } from "react-router-dom";
import { PageHeader } from "../components/ToolShell";
import { t } from "../lib/i18n";

export function NotFound() {
  return (
    <>
      <PageHeader title={t("Page not found")} subtitle={t("That address doesn't match anything here.")} />
      <Link to="/app" className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
        {t("Go to the dashboard")}
      </Link>
    </>
  );
}
