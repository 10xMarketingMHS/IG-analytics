import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Premium glass modal: dimmed + blurred backdrop, centered glass card, smooth
 * open animation. Closes on Escape, backdrop click, or the × button. Locks
 * background scroll and renders in a portal so it overlays the whole app.
 */
export function Modal({
  onClose,
  title,
  children,
  wide,
  variant = "center",
}: {
  onClose: () => void;
  title?: string;
  children: ReactNode;
  wide?: boolean;
  // "drawer" slides in from the right edge instead of the usual centered
  // glass card — for detail panels you want to keep glancing at the list
  // behind (e.g. a task's full detail while the board stays visible).
  variant?: "center" | "drawer";
}) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div className={"modal-overlay" + (variant === "drawer" ? " drawer" : "")} onMouseDown={onClose}>
      <div
        className={"modal-card" + (wide ? " wide" : "") + (variant === "drawer" ? " drawer" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Stop clicks inside the card from bubbling to the backdrop.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
        {title && <h2 className="modal-head">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
