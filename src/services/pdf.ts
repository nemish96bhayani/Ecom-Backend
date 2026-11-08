import PDFDocument from "pdfkit";
import { formatINR } from "../lib/money.js";

type Party = { name: string; address?: string; gstin?: string; stateCode?: string; phone?: string; email?: string };
type Row = { description: string; hsn?: string; qty?: number; rate?: number; taxable: number; taxRate?: number; tax: number; total: number };

/** Generic GST tax invoice (used for customer invoices and platform commission invoices). */
export function renderTaxInvoice(opts: {
  title: string;
  invoiceNumber: string;
  date: Date;
  seller: Party;
  buyer: Party;
  rows: Row[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; total: number };
  notes?: string[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(opts.title, { align: "left" });
    doc.moveDown(0.3).fontSize(10).fillColor("#444").text(`Invoice no. ${opts.invoiceNumber}    Date ${opts.date.toLocaleDateString("en-IN")}`);
    doc.moveDown();

    const party = (label: string, p: Party, x: number) => {
      const y = doc.y;
      doc.fillColor("#000").fontSize(9).text(label, x, y, { width: 250 });
      doc.fontSize(11).text(p.name, x, doc.y, { width: 250 });
      doc.fontSize(9).fillColor("#333");
      for (const line of [p.address, p.gstin && `GSTIN ${p.gstin}`, p.stateCode && `State code ${p.stateCode}`, p.phone, p.email].filter(Boolean) as string[]) {
        doc.text(line, x, doc.y, { width: 250 });
      }
      return doc.y;
    };
    const top = doc.y;
    const leftEnd = party("Sold by", opts.seller, 40);
    doc.y = top;
    const rightEnd = party("Billed to", opts.buyer, 310);
    doc.y = Math.max(leftEnd, rightEnd) + 16;

    const cols = [40, 250, 300, 330, 390, 440, 500];
    const header = ["Item", "HSN", "Qty", "Taxable", "GST %", "Tax", "Total"];
    doc.fontSize(9).fillColor("#000");
    header.forEach((h, i) => doc.text(h, cols[i], doc.y, { width: (cols[i + 1] ?? 555) - cols[i]! - 4, continued: false, lineBreak: false }));
    doc.moveDown(1.2);
    for (const r of opts.rows) {
      const y = doc.y;
      const cells = [r.description, r.hsn ?? "", r.qty ? String(r.qty) : "", formatINR(r.taxable), r.taxRate !== undefined ? `${r.taxRate}%` : "", formatINR(r.tax), formatINR(r.total)];
      cells.forEach((c, i) => doc.text(c, cols[i], y, { width: (cols[i + 1] ?? 555) - cols[i]! - 4 }));
      doc.y = Math.max(doc.y, y + 14) + 4;
    }
    doc.moveDown();
    const t = opts.totals;
    const lines: [string, number][] = [["Taxable value", t.taxable]];
    if (t.igst) lines.push(["IGST", t.igst]);
    else lines.push(["CGST", t.cgst], ["SGST", t.sgst]);
    lines.push(["Total", t.total]);
    for (const [k, v] of lines) doc.fontSize(k === "Total" ? 12 : 10).text(`${k}: ${formatINR(v)}`, 330, doc.y, { width: 225, align: "right" });
    if (opts.notes?.length) {
      doc.moveDown(2).fontSize(8).fillColor("#555");
      for (const n of opts.notes) doc.text(n, 40, doc.y, { width: 515 });
    }
    doc.end();
  });
}

export type ShippingLabelOpts = {
  courier: string;
  awb: string;
  orderNumber: string;
  orderDate: Date;
  paymentMethod: "online" | "cod";
  totalPaise: number;
  shipper: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    phone?: string;
    gstin?: string;
  };
  recipient: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
  };
  weightKg?: number;
  dims?: { l: number; b: number; h: number };
  items: { title: string; sku?: string; quantity: number }[];
};

/** Industry-standard 4x6 inch Indian e-commerce shipping label (288x432 pt). */
export function renderShippingLabel(opts: ShippingLabelOpts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 4 x 6 inches = 288 x 432 pt
    const doc = new PDFDocument({ size: [288, 432], margin: 12 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const m = 12;
    const w = 288 - m * 2; // 264
    const h = 432 - m * 2; // 408

    // Outer bounding border
    doc.lineWidth(1.5).rect(m, m, w, h).strokeColor("#000000").stroke();

    // 1. Courier header
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000000").text(opts.courier.toUpperCase(), m + 6, m + 8, { width: w - 12 });
    doc.font("Helvetica").fontSize(8).fillColor("#555555").text("SURFACE / AIR EXPRESS LOGISTICS", m + 6, m + 24);

    // Separator line
    doc.lineWidth(0.8).moveTo(m, m + 36).lineTo(m + w, m + 36).stroke();

    // 2. Simulated Code-128 Barcode
    const barTop = m + 42;
    const barHeight = 32;
    const barWidth = w - 24;
    // Draw alternating barcode lines deterministically based on AWB string
    const seed = opts.awb || "MOCK1234567890";
    let curX = m + 12;
    for (let i = 0; i < seed.length; i++) {
      const code = seed.charCodeAt(i);
      const widths = [(code % 3) + 1, ((code >> 1) % 2) + 1, ((code >> 2) % 3) + 1, 1];
      for (let j = 0; j < widths.length; j++) {
        const sw = widths[j]!;
        if (j % 2 === 0) {
          doc.rect(curX, barTop, sw, barHeight).fill("#000000");
        }
        curX += sw + 1;
        if (curX > m + 12 + barWidth) break;
      }
      if (curX > m + 12 + barWidth) break;
    }

    // AWB Text
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000").text(`AWB: ${opts.awb}`, m, barTop + barHeight + 4, { align: "center", width: w });

    // Separator line
    const afterBarcodeY = barTop + barHeight + 18;
    doc.lineWidth(0.8).moveTo(m, afterBarcodeY).lineTo(m + w, afterBarcodeY).stroke();

    // 3. Routing Box (Pincode & City)
    doc.rect(m, afterBarcodeY, w, 32).fillAndStroke("#F3F4F6", "#000000");
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#000000").text(`PIN: ${opts.recipient.pincode}`, m + 8, afterBarcodeY + 8, { width: w / 2 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text(opts.recipient.city.toUpperCase(), m + w / 2, afterBarcodeY + 10, { width: w / 2 - 8, align: "right" });

    // 4. Payment Badge Box
    const payBoxY = afterBarcodeY + 32;
    const isCod = opts.paymentMethod === "cod";
    if (isCod) {
      doc.rect(m, payBoxY, w, 24).fillAndStroke("#FEF08A", "#000000");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#854D0E").text(`CASH ON DELIVERY (COD): ${formatINR(opts.totalPaise)}`, m, payBoxY + 6, { align: "center", width: w });
    } else {
      doc.rect(m, payBoxY, w, 24).fillAndStroke("#DCFCE7", "#000000");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#166534").text(`PREPAID - DO NOT COLLECT CASH`, m, payBoxY + 6, { align: "center", width: w });
    }

    // 5. Deliver To (Consignee)
    const deliverY = payBoxY + 30;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#4B5563").text("SHIP TO / DELIVER TO:", m + 8, deliverY);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000").text(opts.recipient.name, m + 8, deliverY + 11);
    doc.font("Helvetica").fontSize(8.5).fillColor("#1F2937");
    let addrY = deliverY + 23;
    const addrLines = [
      opts.recipient.line1,
      opts.recipient.line2,
      `${opts.recipient.city}, ${opts.recipient.state} - ${opts.recipient.pincode}`,
      `Phone: ${opts.recipient.phone}`,
    ].filter(Boolean) as string[];

    for (const line of addrLines) {
      doc.text(line, m + 8, addrY, { width: w - 16 });
      addrY += 11;
    }

    // Separator line
    const shipperY = Math.max(addrY + 4, deliverY + 70);
    doc.lineWidth(0.5).moveTo(m, shipperY).lineTo(m + w, shipperY).strokeColor("#9CA3AF").stroke();

    // 6. Return to / Shipper (Merchant)
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#4B5563").text("RETURN ADDRESS / SHIPPED BY:", m + 8, shipperY + 5);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000000").text(opts.shipper.name, m + 8, shipperY + 15);
    doc.font("Helvetica").fontSize(7.5).fillColor("#374151");
    const shipLines = [
      opts.shipper.address,
      [opts.shipper.city, opts.shipper.state, opts.shipper.pincode].filter(Boolean).join(", "),
      opts.shipper.phone ? `Phone: ${opts.shipper.phone}` : undefined,
      opts.shipper.gstin ? `GSTIN: ${opts.shipper.gstin}` : undefined,
    ].filter(Boolean) as string[];
    let sY = shipperY + 25;
    for (const line of shipLines) {
      doc.text(line, m + 8, sY, { width: w - 16 });
      sY += 9.5;
    }

    // Separator line
    const pkgY = Math.max(sY + 4, shipperY + 56);
    doc.lineWidth(0.5).moveTo(m, pkgY).lineTo(m + w, pkgY).strokeColor("#9CA3AF").stroke();

    // 7. Order & Package Specs
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#111827");
    doc.text(`Order: ${opts.orderNumber}`, m + 8, pkgY + 5, { width: 130 });
    doc.text(`Date: ${opts.orderDate.toLocaleDateString("en-IN")}`, m + 140, pkgY + 5, { width: w - 148, align: "right" });
    const weightStr = opts.weightKg ? `${opts.weightKg.toFixed(2)} kg` : "0.50 kg";
    const dimsStr = opts.dims ? `${opts.dims.l}x${opts.dims.b}x${opts.dims.h} cm` : "20x15x5 cm";
    doc.font("Helvetica").fontSize(7).fillColor("#4B5563");
    doc.text(`Weight: ${weightStr}  |  Dims: ${dimsStr}`, m + 8, pkgY + 16);

    // Items line
    const itemsStr = opts.items.map((it) => `${it.title} (x${it.quantity})`).join(", ");
    doc.font("Helvetica").fontSize(7).fillColor("#4B5563").text(`Items: ${itemsStr}`, m + 8, pkgY + 27, { width: w - 16, height: 18, ellipsis: true });

    // Footer
    const footerY = m + h - 14;
    doc.lineWidth(0.5).moveTo(m, footerY - 4).lineTo(m + w, footerY - 4).strokeColor("#D1D5DB").stroke();
    doc.font("Helvetica").fontSize(6.5).fillColor("#6B7280").text("Standard Indian E-Commerce Shipping Label · Handled under multi-tenant logistics", m, footerY, { align: "center", width: w });

    doc.end();
  });
}

