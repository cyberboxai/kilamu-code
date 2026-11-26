/** Format cents as a Kwanza amount, e.g. 123450 -> "1 234,50 Kz". */
export function formatKz(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${units},${String(abs % 100).padStart(2, '0')} Kz`;
}
