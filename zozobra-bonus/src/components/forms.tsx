"use client";

import { useFormStatus } from "react-dom";
import { buttonClass } from "./ui";

export function SubmitButton({
  children,
  pendingText = "שומר…",
  variant = "primary",
  size = "md",
  className = "",
  name,
  value,
  confirm,
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  className?: string;
  name?: string;
  value?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={`${buttonClass(variant, size)} ${className}`}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </button>
  );
}

export function CheckAll({ form, name }: { form: string; name: string }) {
  return (
    <input
      type="checkbox"
      aria-label="בחירת הכל"
      className="h-4 w-4 accent-[#cfa95f]"
      onChange={(e) => {
        const f = document.getElementById(form) as HTMLFormElement | null;
        f?.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((c) => (c.checked = e.target.checked));
      }}
    />
  );
}
