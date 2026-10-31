import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", icon, className = "", children, type = "button", ...rest }: Props) {
  return (
    <button type={type} className={`btn btn--${variant} btn--${size} ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}
