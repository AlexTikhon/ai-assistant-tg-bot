/**
 * Builds a small, well-formed PDF with one line of text per page (no dependencies, deterministic).
 * `pages[0]` is page 1. Characters outside printable ASCII are not supported.
 */
export function buildPdf(pages: string[]) {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const pageObjectNumber = (index: number) => 4 + index * 2;
  const contentObjectNumber = (index: number) => 5 + index * 2;

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, index) => {
    const stream = `BT /F1 18 Tf 20 100 Td (${escape(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents ${contentObjectNumber(index)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => (pdf += `${String(offset).padStart(10, "0")} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
