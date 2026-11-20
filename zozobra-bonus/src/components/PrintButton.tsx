"use client";
import { buttonClass } from "./ui";

export function PrintButton() {
  return (
    <button className={buttonClass("secondary", "sm") + " print:hidden"} onClick={() => window.print()}>
      הדפסה
    </button>
  );
}
