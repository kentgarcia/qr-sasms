"use client";

import { useEffect } from "react";
import { Toaster, toast } from "sonner";

declare global {
  interface Window {
    __starsToast?: (message: string, bgOrType?: string) => void;
  }
}

function toPlainMessage(raw: string): string {
  return String(raw ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const BrandIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6L12 2z" />
  </svg>
);

const SuccessIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const ErrorIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M15 9l-6 6M9 9l6 6" />
  </svg>
);

const WarningIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

const InfoIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);

function dispatchStarsToast(rawMessage: string, bgOrType?: string) {
  const plain = toPlainMessage(rawMessage);
  if (!plain) return;

  const hint = String(bgOrType || "").trim().toLowerCase();

  let kind: "success" | "error" | "warning" | "info" | "default" = "default";
  let text = plain;

  if (hint === "error" || hint === "warning" || hint === "success" || hint === "info") {
    kind = hint;
  } else if (/^❌/.test(plain)) {
    kind = "error";
    text = plain.replace(/^❌\s*/, "");
  } else if (/^(⚠️|⚠|⏳)/.test(plain)) {
    kind = "warning";
    text = plain.replace(/^(⚠️|⚠|⏳)\s*/, "");
  } else if (/^(✅|✔|⭐)/.test(plain)) {
    kind = "success";
    text = plain.replace(/^(✅|✔|⭐)\s*/, "");
  } else if (/^(ℹ️|📧)/.test(plain)) {
    kind = "info";
    text = plain.replace(/^(ℹ️|📧)\s*/, "");
  } else if (/155\s*,\s*22\s*,\s*22|185\s*,\s*28\s*,\s*28|220\s*,\s*38\s*,\s*38|dc2626|b91c1c|ef4444|991b1b/.test(hint)) {
    kind = "error";
  } else if (/180\s*,\s*130\s*,\s*0|d97706|eab308|a16207/.test(hint)) {
    kind = "warning";
  } else if (/22\s*,\s*163\s*,\s*74|15803d|166534|22c55e/.test(hint)) {
    kind = "success";
  } else if (/37\s*,\s*99\s*,\s*235|1d4ed8/.test(hint)) {
    kind = "info";
  }

  const finalText = text || plain;
  if (kind === "error") toast.error(finalText);
  else if (kind === "warning") toast.warning(finalText);
  else if (kind === "success") toast.success(finalText);
  else if (kind === "info") toast.info(finalText);
  else toast(finalText, { icon: BrandIcon });
}

export default function ToastProvider() {
  useEffect(() => {
    window.__starsToast = dispatchStarsToast;
    return () => {
      if (window.__starsToast === dispatchStarsToast) {
        delete window.__starsToast;
      }
    };
  }, []);

  return (
    <Toaster
      position="top-center"
      closeButton
      duration={3400}
      gap={8}
      offset={{ top: 14 }}
      style={{ zIndex: 100000 }}
      icons={{
        success: SuccessIcon,
        error: ErrorIcon,
        warning: WarningIcon,
        info: InfoIcon,
      }}
      toastOptions={{
        classNames: {
          toast: "stars-toast",
          title: "stars-toast-title",
          description: "stars-toast-desc",
          icon: "stars-toast-icon",
          closeButton: "stars-toast-close",
          actionButton: "stars-toast-action",
          cancelButton: "stars-toast-cancel",
        },
      }}
    />
  );
}
