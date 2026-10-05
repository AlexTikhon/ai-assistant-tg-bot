import { describe, expect, it } from "vitest";
import { findTextProblem, hasPdfSignature, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayFileName } from "../../src/core/file-validation.js";

describe("PDF signature", () => {
  it("accepts %PDF- at the start, and within the first 1024 bytes (producers may prepend bytes)", () => {
    expect(hasPdfSignature(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(hasPdfSignature(Buffer.concat([Buffer.from("junk\n".repeat(50)), Buffer.from("%PDF-1.4\n")]))).toBe(true);
  });

  it("rejects anything else, including a signature that only appears later", () => {
    expect(hasPdfSignature(Buffer.from("This is just text"))).toBe(false);
    expect(hasPdfSignature(Buffer.from("<html>%PDF-</html>".padStart(2000, " ")))).toBe(false);
    expect(hasPdfSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe("text validation", () => {
  it("accepts ordinary UTF-8 text, Markdown, Unicode, a BOM and Windows line endings", () => {
    for (const text of ["Hello\nworld", "# Title\n\nSome *Markdown*", "Привет, мир — 你好 📄", "\uFEFFwith a BOM", "line one\r\nline two\r\n", "tabs\tand spaces"]) {
      expect(findTextProblem(Buffer.from(text, "utf-8")), text).toBeNull();
    }
  });

  it("tolerates a few damaged bytes in a large text, but not a file in another encoding", () => {
    const mostlyFine = Buffer.concat([Buffer.from("Plain readable text. ".repeat(500)), Buffer.from([0xff, 0xfe, 0x80])]);
    const windows1251 = Buffer.from("Привет, мир! Это текст в кодировке Windows-1251. ".repeat(20), "latin1").map((byte) => byte | 0x80);

    expect(findTextProblem(mostlyFine)).toBeNull();
    expect(findTextProblem(Buffer.from(windows1251))).toBe("not-utf8");
  });

  it("rejects binary data: a NUL byte does not occur in text", () => {
    expect(findTextProblem(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe("binary"); // PNG
    expect(findTextProblem(Buffer.from("PK\u0003\u0004\u0000\u0000", "latin1"))).toBe("binary"); // ZIP / docx
    expect(findTextProblem(Buffer.from("hi", "utf16le"))).toBe("binary"); // UTF-16 text
    expect(findTextProblem(Buffer.from("text with a\u0000hidden NUL"))).toBe("binary");
  });

  it("recognises a PDF named like a text file", () => {
    expect(findTextProblem(Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n"))).toBe("pdf");
  });

  it("an empty file has no text problem (emptiness is reported elsewhere)", () => {
    expect(findTextProblem(Buffer.alloc(0))).toBeNull();
  });
});

describe("display file names are metadata: cleaned, bounded, never a path", () => {
  it("keeps safe names as they are, Unicode included", () => {
    for (const name of ["report.pdf", "Отчёт 2026.md", "日本語のファイル.txt", "notes (final) v2.txt", "emoji 📄.md", "a b  c.txt".replace("  ", " ")]) {
      expect(normalizeDisplayFileName(name), name).toBe(name.normalize("NFC"));
    }
  });

  it("does not turn a path into a different name: slashes are kept as text (the stored file never uses it)", () => {
    expect(normalizeDisplayFileName("../../secret.txt")).toBe("../../secret.txt");
    expect(normalizeDisplayFileName("C:\\Windows\\system.ini")).toBe("C:\\Windows\\system.ini");
  });

  it("removes control characters, NUL, bidirectional overrides and zero-width characters", () => {
    expect(normalizeDisplayFileName("a\u0000b\u0007c\u001b[31m.txt")).toBe("abc[31m.txt");
    expect(normalizeDisplayFileName("invoice\u202Etxt.exe.pdf")).toBe("invoicetxt.exe.pdf");
    expect(normalizeDisplayFileName("zero\u200Bwidth\uFEFF.md")).toBe("zerowidth.md");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeDisplayFileName("  my\t\n  file   name.txt  ")).toBe("my file name.txt");
  });

  it("bounds the length and keeps the extension", () => {
    const long = normalizeDisplayFileName(`${"a".repeat(1000)}.pdf`);

    expect(long.length).toBe(MAX_DISPLAY_NAME_LENGTH);
    expect(long.endsWith("a.pdf")).toBe(true);
  });

  it("never cuts a character in half", () => {
    const name = normalizeDisplayFileName(`${"x".repeat(MAX_DISPLAY_NAME_LENGTH - 5)}📄📄📄📄.md`);

    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(name.endsWith(".md")).toBe(true);
  });

  it("a name that is only dangerous characters becomes empty, which the extension check then rejects", () => {
    expect(normalizeDisplayFileName("\u0000\u202E")).toBe("");
  });
});
