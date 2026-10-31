"use client";
import { cn } from "@/lib/utils";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from "react";

export function Button({
  variant = "primary",
  size,
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm";
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      className={cn(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "secondary" && "btn-secondary",
        variant === "danger" && "btn-danger",
        variant === "ghost" && "btn-ghost",
        size === "sm" && "btn-sm",
        className
      )}
      disabled={props.disabled || loading}
    >
      {loading ? (
        <span className="inline-block w-3.5 h-3.5 border-2 border-white/50 border-t-transparent rounded-full animate-spin" />
      ) : null}
      {children}
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("input", className)} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("textarea", className)} />;
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn("select", className)} />;
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-sm font-medium mb-1.5 text-[color:var(--fg)]"
    >
      {children}
    </label>
  );
}

export function Card({
  children,
  className,
  padding = "p-5",
}: {
  children: ReactNode;
  className?: string;
  padding?: string;
}) {
  return <div className={cn("card", padding, className)}>{children}</div>;
}

export function Badge({
  children,
  variant = "muted",
  className,
}: {
  children: ReactNode;
  variant?: "success" | "warn" | "error" | "info" | "muted";
  className?: string;
}) {
  return (
    <span className={cn("badge", `badge-${variant}`, className)}>{children}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: "success" | "warn" | "error" | "info" | "muted"; label: string; dot?: boolean }> = {
    RUNNING: { variant: "success", label: "Running", dot: true },
    STARTING: { variant: "info", label: "Starting", dot: true },
    INSTALLING: { variant: "info", label: "Installing", dot: true },
    BUILDING: { variant: "info", label: "Building", dot: true },
    STOPPING: { variant: "warn", label: "Stopping" },
    STOPPED: { variant: "muted", label: "Stopped" },
    CREATED: { variant: "muted", label: "Created" },
    CRASHED: { variant: "error", label: "Crashed" },
    ERROR: { variant: "error", label: "Error" },
    SUSPENDED: { variant: "warn", label: "Suspended" },
  };
  const s = map[status] ?? { variant: "muted" as const, label: status };
  return (
    <Badge variant={s.variant}>
      {s.dot && (
        <span
          className={cn(
            "status-dot",
            s.variant === "success" && "bg-emerald-400 pulse-dot",
            s.variant === "info" && "bg-blue-400 pulse-dot"
          )}
        />
      )}
      {s.label}
    </Badge>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 pt-16"
      onClick={onClose}
    >
      <div
        className={cn("card w-full animate-fadein", maxWidth)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[color:var(--border)] px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Toast({
  message,
  type = "info",
  onDone,
}: {
  message: string;
  type?: "info" | "success" | "error";
  onDone?: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), 3500);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      className={cn(
        "fixed bottom-6 right-6 z-[60] card px-4 py-3 shadow-xl animate-fadein text-sm max-w-sm",
        type === "success" && "border-emerald-500/40",
        type === "error" && "border-red-500/40"
      )}
    >
      {message}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{
    message: string;
    type?: "info" | "success" | "error";
  } | null>(null);
  const show = (message: string, type: "info" | "success" | "error" = "info") =>
    setToast({ message, type });
  return {
    show,
    element: toast ? (
      <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />
    ) : null,
  };
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="text-center py-14 px-6">
      {icon && (
        <div className="mx-auto mb-4 h-14 w-14 flex items-center justify-center rounded-2xl bg-[color:var(--card-2)] border border-[color:var(--border)] text-[color:var(--muted)]">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && (
        <p className="text-sm text-[color:var(--muted)] mt-1 max-w-sm mx-auto">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}
