export function Logo({ size = "md", subtitle }: { size?: "md" | "lg"; subtitle?: boolean }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <b
        dir="ltr"
        className={`font-brand font-bold tracking-[0.18em] text-ink ${size === "lg" ? "text-5xl" : "text-[1.6rem]"}`}
        style={{ paddingInlineStart: "0.18em" }}
      >
        ZOZ<i className="not-italic text-red">O</i>BRA
      </b>
      {(subtitle ?? size === "lg") ? <span className="mt-1.5 text-xs tracking-wide text-muted">מערכת בונוסים לצוות</span> : null}
    </div>
  );
}
