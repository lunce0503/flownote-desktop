// Synthetic, valid PDF; the unreferenced stream exercises original-file preservation.
export function textbookPdf(size = 1024) {
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  let length = parts[0].length;
  const object = (id, content) => {
    offsets[id] = length;
    const bytes = Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from('\nendobj\n')]);
    parts.push(bytes); length += bytes.length;
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
  const text = 'BT /F1 24 Tf 70 700 Td (Synthetic native textbook) Tj ET';
  object(4, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // Reserve 512 bytes for the final xref, then pad after EOF to the exact boundary.
  const padding = Math.max(0, size - length - 700);
  object(6, Buffer.concat([Buffer.from(`<< /Length ${padding} >>\nstream\n`), Buffer.alloc(padding, 32), Buffer.from('\nendstream')]));
  const xref = length;
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const pdf = Buffer.concat(parts);
  return pdf.length >= size ? pdf : Buffer.concat([pdf, Buffer.alloc(size - pdf.length, 32)]);
}
