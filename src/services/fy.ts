/** Indian financial year label, e.g. 2026-27 for dates from 1 Apr 2026 to 31 Mar 2027. */
export function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}
