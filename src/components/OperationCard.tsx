import { ChevronRight, type LucideIcon } from "lucide-react";
import "./OperationCard.css";

interface Props {
  title: string;
  description: string;
  Icon: LucideIcon;
  featured?: boolean;
  /** Small label such as "Coming later". */
  tag?: string;
  /** Where the tag sits on wide cards; it always drops below the text when space is tight. */
  tagPosition?: "below" | "corner";
  /** Greyed out but still focusable, so its reason can be read. */
  disabled?: boolean;
  reason?: string;
  onClick: () => void;
}

/** The whole card is one button, so it is a single tab stop and click target. */
export function OperationCard({ title, description, Icon, featured = false, tag, tagPosition = "below", disabled = false, reason, onClick }: Props) {
  return (
    <button className={`op-card ${featured ? "op-card--featured" : ""} ${disabled ? "op-card--disabled" : ""} ${tagPosition === "corner" ? "op-card--corner" : ""}`} aria-disabled={disabled || undefined} title={disabled ? reason : undefined} onClick={() => !disabled && onClick()}>
      <span className="op-card__tile">
        <Icon size={30} strokeWidth={2} aria-hidden />
      </span>
      <span className="op-card__text">
        <span className="op-card__title">{title}</span>
        <span className="op-card__desc">{description}</span>
        {tag && <span className="op-card__tag">{tag}</span>}
      </span>
      <ChevronRight className="op-card__arrow" size={20} aria-hidden />
    </button>
  );
}
