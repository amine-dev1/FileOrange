import "./ProgressBar.css";

export function ProgressBar({ percent, label, indeterminate = false }: { percent: number; label: string; indeterminate?: boolean }) {
  return (
    <div
      className={`progress ${indeterminate ? "progress--indeterminate" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
    >
      <div className="progress__bar" style={indeterminate ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }} />
    </div>
  );
}
