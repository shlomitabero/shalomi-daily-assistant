export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <div className="flex flex-col items-center leading-none" dir="ltr">
      <span
        className={`font-display font-black tracking-[0.32em] gold-text ${size === "lg" ? "text-4xl" : "text-lg"}`}
        style={{ paddingInlineStart: "0.32em" }}
      >
        ZOZOBRA
      </span>
      {size === "lg" ? <span className="mt-2 text-[0.65rem] tracking-[0.4em] text-muted">PAN · ASIAN · KITCHEN</span> : null}
    </div>
  );
}
