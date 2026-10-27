/** Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection. */
export type CsvValue = string | number | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Prevent spreadsheet formula execution for text that starts with =, +, -, @, tab or CR.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}
