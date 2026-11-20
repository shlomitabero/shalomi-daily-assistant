import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, toXlsx, type ExportRow } from "@/lib/payroll-export";
import { isPeriod, periodToDate } from "@shared/period.ts";

export async function GET(req: NextRequest) {
  const me = await getMe();
  if (me?.employee.app_role !== "admin") return new NextResponse("אין הרשאה", { status: 403 });
  const period = req.nextUrl.searchParams.get("period") ?? "";
  const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  if (!isPeriod(period)) return new NextResponse("תקופה לא תקינה", { status: 400 });

  const sb = await createClient();
  const [{ data, error }, { data: branch }] = await Promise.all([
    sb
      .from("bonus_payouts")
      .select("amount, status, employees!inner(payroll_id, first_name, last_name, phone, job_role, tip_based)")
      .eq("period", periodToDate(period))
      .in("status", ["approved", "paid"])
      .gt("amount", 0),
    sb.from("branches").select("payroll_component_code").eq("id", me.employee.branch_id).single(),
  ]);
  if (error) return new NextResponse(error.message, { status: 500 });

  const rows: ExportRow[] = (data ?? [])
    .map((p) => ({ ...(p.employees as unknown as Omit<ExportRow, "amount" | "status">), amount: p.amount, status: p.status }))
    .sort((a, b) => (a.payroll_id ?? "").localeCompare(b.payroll_id ?? "", "he", { numeric: true }));
  const code = branch?.payroll_component_code ?? "BONUS";
  const name = `zozobra-bonus-${period}`;

  if (format === "xlsx") {
    const buf = await toXlsx(rows, period, code);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return new NextResponse(toCsv(rows, period, code), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
