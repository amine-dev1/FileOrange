import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import "./toast.css";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

interface Ctx {
  push: (tone: Tone, message: string) => void;
}

const ToastContext = createContext<Ctx | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 9000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);
  const Icon = { success: CheckCircle2, error: XCircle, info: Info };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const I = Icon[t.tone];
          return (
            <div key={t.id} className={`toast toast--${t.tone}`}>
              <I size={18} aria-hidden />
              <span className="toast__msg">{t.message}</span>
              <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <X size={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const c = useContext(ToastContext);
  if (!c) throw new Error("useToast outside ToastProvider");
  return c;
}
