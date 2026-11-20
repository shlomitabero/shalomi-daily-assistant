import { describe, expect, it } from "vitest";
import { csvToRows, guessMapping, parseCsv, parseNumber, parsePeriod, resolveMetric } from "./csv.ts";

describe("parseCsv", () => {
  it("handles BOM, quotes, CRLF and semicolons", () => {
    const p = parseCsv('﻿שם;מדד;ערך\r\n"כהן, נועה";survey;"4,6"\r\n\r\n');
    expect(p.delimiter).toBe(";");
    expect(p.headers).toEqual(["שם", "מדד", "ערך"]);
    expect(p.rows).toEqual([["כהן, נועה", "survey", "4,6"]]);
  });
  it("handles escaped quotes", () => {
    expect(parseCsv('a,b\n"x ""y""",2').rows).toEqual([['x "y"', "2"]]);
  });
});

describe("value parsing", () => {
  it.each([
    ["1,234.5", 1234.5], ["92%", 92], ["₪ 1,200,000", 1200000], ["4,6", 4.6],
    ["1.234,5", 1234.5], ["4.232", 4.232], ["1.234.567", 1234567], ["(5)", -5], ["", null], ["abc", null],
  ])("%s → %s", (raw, n) => expect(parseNumber(raw)).toBe(n));

  it.each([["2027-01", "2027-01"], ["2027-1-31", "2027-01"], ["01/2027", "2027-01"], ["31/01/2027", "2027-01"], ["13/2027", null]])(
    "period %s → %s", (raw, p) => expect(parsePeriod(raw)).toBe(p));

  it("resolves metric ids and Hebrew names", () => {
    expect(resolveMetric("survey")).toBe("survey");
    expect(resolveMetric(" הגעה ליעד  מחזור ")).toBe("revenue");
    expect(resolveMetric("nope")).toBeNull();
  });
});

describe("mapping", () => {
  it("guesses Hebrew headers", () => {
    expect(guessMapping(["חודש", "מספר עובד", "שם", "מדד", "ערך"], "2027-01")).toMatchObject({
      period: "חודש", employeeId: "מספר עובד", employeeName: "שם", metric: "מדד", value: "ערך",
    });
  });
  it("uses the default period when the column is missing or empty", () => {
    const p = parseCsv("name,metric,value\nנועה,survey,4.8");
    const [r] = csvToRows(p, { ...guessMapping(p.headers, "2027-03") });
    expect(r.row).toMatchObject({ period: "2027-03", employeeName: "נועה", value: 4.8 });
  });
  it("reports the file line number of a bad row", () => {
    const p = parseCsv("metric,value\nsurvey,4\nsurvey,x");
    const r = csvToRows(p, guessMapping(p.headers, "2027-01"));
    expect(r[1]).toMatchObject({ line: 3, ok: false });
  });
});
