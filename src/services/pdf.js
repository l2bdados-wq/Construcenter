const PDFDocument = require('pdfkit');
const fs = require('node:fs');
const { getTenantPaths, getCurrentTenantSlug } = require('../db/database');
const {
  formatCents,
  formatQuantity,
  formatDateTimeBR,
  formatDateBR,
} = require('../utils/format');

function drawHeader(doc, store, rightTitle, rightSubtitle) {
  const startY = doc.y;
  const { logoPath } = getTenantPaths(getCurrentTenantSlug());
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, startY, { fit: [100, 82] });
    } catch (_) {
      // fallback if image fails
    }
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor('#1E2022')
    .text(rightTitle, 230, startY, { align: 'right', width: 325 });

  if (rightSubtitle) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#555555')
      .text(rightSubtitle, 230, doc.y + 2, { align: 'right', width: 325 });
  }

  const infoY = Math.max(startY + 86, doc.y + 10);
  const storeLine = [
    store?.name || 'CONSTRUCENTER',
    store?.cnpj ? `CNPJ: ${store.cnpj}` : '',
    store?.phone ? `Tel/WhatsApp: ${store.phone}` : '',
    store?.address || '',
  ]
    .filter(Boolean)
    .join('  •  ');

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#444444')
    .text(storeLine, 40, infoY, { width: 515 });

  doc
    .moveTo(40, doc.y + 5)
    .lineTo(555, doc.y + 5)
    .strokeColor('#E68A2E')
    .lineWidth(1.5)
    .stroke();

  doc.y = doc.y + 12;
}

function ensureSpace(doc, needed = 60) {
  if (doc.y + needed > 760) {
    doc.addPage();
    doc.y = 40;
  }
}

function drawTableRow(doc, cols, y, isHeader = false, zebra = false) {
  const rowHeight = 18;
  if (y + rowHeight > 760) {
    doc.addPage();
    y = 40;
  }
  if (isHeader) {
    doc.rect(40, y, 515, rowHeight).fill('#1E2022');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
  } else {
    if (zebra) {
      doc.rect(40, y, 515, rowHeight).fill('#F9FAFB');
    }
    doc.fillColor('#1E2022').font('Helvetica').fontSize(8);
  }

  for (const col of cols) {
    doc.text(String(col.text ?? ''), col.x, y + 5, {
      width: col.w,
      align: col.align || 'left',
      ellipsis: true,
      lineBreak: false,
    });
  }
  return y + rowHeight;
}

function generateWithdrawalReceiptPDF(withdrawal, store, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="comprovante_${withdrawal.code}.pdf"`
  );
  doc.pipe(res);

  drawHeader(
    doc,
    store,
    `COMPROVANTE DE RETIRADA ${withdrawal.code}`,
    `Situação: ${withdrawal.status.toUpperCase()}  •  Documento sem valor fiscal`
  );

  // Customer & withdrawal details box
  const boxY = doc.y;
  doc.roundedRect(40, boxY, 515, 76, 4).strokeColor('#D1D5DB').lineWidth(0.8).stroke();

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1E2022');
  doc.text(`Cliente: ${withdrawal.customer_name}`, 50, boxY + 8, { width: 300 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#333333');
  doc.text(`CPF/CNPJ: ${withdrawal.customer_document || 'Não informado'}`, 50, boxY + 22);
  doc.text(`Telefone: ${withdrawal.customer_phone || 'Não informado'}`, 50, boxY + 35);
  doc.text(`Obra/Referência: ${withdrawal.work_reference || 'Não informada'}`, 50, boxY + 48);
  doc.text(`Retirado por: ${withdrawal.picked_up_by}`, 50, boxY + 61);

  doc.text(`Data/Hora: ${formatDateTimeBR(withdrawal.withdrawal_date)}`, 360, boxY + 8, {
    width: 185,
    align: 'right',
  });
  doc.text(`Atendente: ${withdrawal.employee_name}`, 360, boxY + 22, {
    width: 185,
    align: 'right',
  });
  if (withdrawal.order_number) {
    doc.text(`Pedido vinculado: ${withdrawal.order_number}`, 360, boxY + 35, {
      width: 185,
      align: 'right',
    });
  }

  doc.y = boxY + 88;

  // Items table
  let y = doc.y;
  const colsHeader = [
    { text: 'Código', x: 45, w: 65 },
    { text: 'Descrição', x: 112, w: 210 },
    { text: 'Unid.', x: 325, w: 45, align: 'center' },
    { text: 'Qtd.', x: 372, w: 50, align: 'right' },
    { text: 'V. Unit.', x: 426, w: 60, align: 'right' },
    { text: 'Subtotal', x: 490, w: 60, align: 'right' },
  ];
  y = drawTableRow(doc, colsHeader, y, true);

  withdrawal.items.forEach((item, idx) => {
    y = drawTableRow(
      doc,
      [
        { text: item.product_code, x: 45, w: 65 },
        { text: item.product_description, x: 112, w: 210 },
        { text: item.product_unit, x: 325, w: 45, align: 'center' },
        { text: formatQuantity(item.quantity), x: 372, w: 50, align: 'right' },
        { text: formatCents(item.unit_price_cents), x: 426, w: 60, align: 'right' },
        { text: formatCents(item.subtotal_cents), x: 490, w: 60, align: 'right' },
      ],
      y,
      false,
      idx % 2 === 1
    );
  });

  doc.y = y + 10;

  if (withdrawal.returns && withdrawal.returns.length > 0) {
    ensureSpace(doc, 60);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#B91C1C').text('Devoluções Registradas:', 40);
    doc.font('Helvetica').fontSize(8).fillColor('#333333');
    for (const ret of withdrawal.returns) {
      doc.text(
        `• ${formatDateTimeBR(ret.returned_at)} - ${ret.product_description}: Qtd ${formatQuantity(ret.quantity)} (${formatCents(ret.refund_cents)}) — Motivo: ${ret.reason}`,
        45,
        doc.y + 2
      );
    }
    doc.y += 8;
  }

  ensureSpace(doc, 110);
  const totalsY = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  doc.text(`Subtotal dos Itens: ${formatCents(withdrawal.items_subtotal_cents)}`, 350, totalsY, {
    width: 205,
    align: 'right',
  });
  if (withdrawal.returns_total_cents > 0) {
    doc.text(`(-) Devoluções: ${formatCents(withdrawal.returns_total_cents)}`, 350, doc.y + 2, {
      width: 205,
      align: 'right',
    });
  }
  if (withdrawal.discount_cents > 0) {
    doc.text(`(-) Desconto: ${formatCents(withdrawal.discount_cents)}`, 350, doc.y + 2, {
      width: 205,
      align: 'right',
    });
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#1E2022')
    .text(`TOTAL DA RETIRADA: ${formatCents(withdrawal.net_total_cents)}`, 320, doc.y + 4, {
      width: 235,
      align: 'right',
    });

  if (withdrawal.notes) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#444444').text(`Observações: ${withdrawal.notes}`, 40, totalsY, {
      width: 290,
    });
  }

  // Signature block
  ensureSpace(doc, 80);
  const sigY = Math.max(doc.y + 35, 650);
  doc.moveTo(60, sigY).lineTo(270, sigY).strokeColor('#333333').lineWidth(0.8).stroke();
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#333333')
    .text(`Assinatura: ${withdrawal.picked_up_by}`, 60, sigY + 5, { width: 210, align: 'center' });

  doc.moveTo(325, sigY).lineTo(535, sigY).strokeColor('#333333').lineWidth(0.8).stroke();
  doc.text(`Funcionário: ${withdrawal.employee_name}`, 325, sigY + 5, { width: 210, align: 'center' });

  doc.end();
}

function generateOrderPDF(orderData, store, mode = 'consolidated', res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="pedido_${orderData.order_number}.pdf"`
  );
  doc.pipe(res);

  drawHeader(
    doc,
    store,
    `PEDIDO ${orderData.order_number}`,
    `Pedido — sem valor fiscal  •  Emissão: ${formatDateTimeBR(orderData.issued_at)}`
  );

  // Banner "Pedido — sem valor fiscal"
  const bannerY = doc.y;
  doc.roundedRect(40, bannerY, 515, 20, 3).fill('#FEF3C7');
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#92400E')
    .text('PEDIDO — SEM VALOR FISCAL', 40, bannerY + 5, { width: 515, align: 'center' });
  doc.y = bannerY + 28;

  // Customer & Order info
  const infoY = doc.y;
  doc.roundedRect(40, infoY, 515, 72, 4).strokeColor('#D1D5DB').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1E2022');
  doc.text(`Cliente: ${orderData.customer.name}`, 50, infoY + 8, { width: 295 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#333333');
  doc.text(`CPF/CNPJ: ${orderData.customer.document || 'Não informado'}`, 50, infoY + 22);
  doc.text(`Telefone: ${orderData.customer.phone || 'Não informado'}`, 50, infoY + 35);
  doc.text(`Endereço: ${orderData.customer.address || 'Não informado'}`, 50, infoY + 48, { width: 295 });

  doc.text(
    `Período: ${formatDateBR(orderData.period_start)} a ${formatDateBR(orderData.period_end)}`,
    350,
    infoY + 8,
    { width: 195, align: 'right' }
  );
  doc.text(
    `Cond. Pagamento: ${orderData.payment_condition || 'A combinar'}`,
    350,
    infoY + 22,
    { width: 195, align: 'right' }
  );
  doc.text(
    `Vencimento: ${orderData.due_date ? formatDateBR(orderData.due_date) : 'Não informado'}`,
    350,
    infoY + 35,
    { width: 195, align: 'right' }
  );
  doc.text(
    `Retiradas de origem: ${orderData.withdrawals.map((w) => w.code).join(', ')}`,
    350,
    infoY + 48,
    { width: 195, align: 'right' }
  );

  doc.y = infoY + 84;

  if (mode === 'consolidated' || mode === 'both') {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1E2022')
      .text('Resumo Consolidado dos Produtos', 40, doc.y);
    doc.y += 6;

    let y = doc.y;
    y = drawTableRow(
      doc,
      [
        { text: 'Código', x: 45, w: 65 },
        { text: 'Descrição', x: 112, w: 210 },
        { text: 'Unid.', x: 325, w: 45, align: 'center' },
        { text: 'Qtd. Total', x: 372, w: 50, align: 'right' },
        { text: 'V. Unit.', x: 426, w: 60, align: 'right' },
        { text: 'Total', x: 490, w: 60, align: 'right' },
      ],
      y,
      true
    );

    orderData.consolidated_items.forEach((item, idx) => {
      y = drawTableRow(
        doc,
        [
          { text: item.product_code, x: 45, w: 65 },
          { text: item.product_description, x: 112, w: 210 },
          { text: item.product_unit, x: 325, w: 45, align: 'center' },
          { text: formatQuantity(item.quantity), x: 372, w: 50, align: 'right' },
          { text: formatCents(item.unit_price_cents), x: 426, w: 60, align: 'right' },
          { text: formatCents(item.subtotal_cents), x: 490, w: 60, align: 'right' },
        ],
        y,
        false,
        idx % 2 === 1
      );
    });
    doc.y = y + 14;
  }

  if (mode === 'detailed' || mode === 'both') {
    ensureSpace(doc, 70);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1E2022')
      .text('Detalhamento das Retiradas por Data', 40, doc.y);
    doc.y += 8;

    for (const w of orderData.withdrawals) {
      ensureSpace(doc, 65);
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor('#E68A2E')
        .text(
          `${w.code}  •  ${formatDateTimeBR(w.withdrawal_date)}  •  Retirado por: ${w.picked_up_by}${w.work_reference ? `  •  Obra: ${w.work_reference}` : ''}`,
          40,
          doc.y
        );
      doc.y += 4;

      let y = doc.y;
      y = drawTableRow(
        doc,
        [
          { text: 'Código', x: 45, w: 65 },
          { text: 'Descrição', x: 112, w: 210 },
          { text: 'Unid.', x: 325, w: 45, align: 'center' },
          { text: 'Qtd.', x: 372, w: 50, align: 'right' },
          { text: 'V. Unit.', x: 426, w: 60, align: 'right' },
          { text: 'Subtotal', x: 490, w: 60, align: 'right' },
        ],
        y,
        true
      );

      w.items.forEach((item, idx) => {
        y = drawTableRow(
          doc,
          [
            { text: item.product_code, x: 45, w: 65 },
            { text: item.product_description, x: 112, w: 210 },
            { text: item.product_unit, x: 325, w: 45, align: 'center' },
            { text: formatQuantity(item.quantity), x: 372, w: 50, align: 'right' },
            { text: formatCents(item.unit_price_cents), x: 426, w: 60, align: 'right' },
            { text: formatCents(item.subtotal_cents), x: 490, w: 60, align: 'right' },
          ],
          y,
          false,
          idx % 2 === 1
        );
      });

      doc.y = y + 4;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#444444')
        .text(
          `Líquido da retirada: ${formatCents(w.net_total_cents)}` +
            (w.discount_cents > 0 ? ` (Desconto: ${formatCents(w.discount_cents)})` : '') +
            (w.returns_total_cents > 0 ? ` (Devoluções: ${formatCents(w.returns_total_cents)})` : ''),
          40,
          doc.y,
          { width: 515, align: 'right' }
        );
      doc.y += 10;
    }
  }

  ensureSpace(doc, 80);
  const totY = doc.y;
  doc.moveTo(40, totY).lineTo(555, totY).strokeColor('#D1D5DB').lineWidth(0.8).stroke();
  doc.y = totY + 8;

  if (orderData.notes) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#444444').text(`Observações: ${orderData.notes}`, 40, doc.y, {
      width: 280,
    });
  }

  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  doc.text(`Subtotal Bruto: ${formatCents(orderData.subtotal_cents)}`, 340, totY + 8, {
    width: 215,
    align: 'right',
  });
  if (orderData.returns_cents > 0) {
    doc.text(`(-) Devoluções: ${formatCents(orderData.returns_cents)}`, 340, doc.y + 2, {
      width: 215,
      align: 'right',
    });
  }
  if (orderData.discount_cents > 0) {
    doc.text(`(-) Descontos: ${formatCents(orderData.discount_cents)}`, 340, doc.y + 2, {
      width: 215,
      align: 'right',
    });
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#1E2022')
    .text(`TOTAL GERAL: ${formatCents(orderData.total_cents)}`, 320, doc.y + 6, {
      width: 235,
      align: 'right',
    });

  doc.end();
}

function generateReportPDF({ title, subtitle, columns, rows, summaryLines = [], store }, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="relatorio_construcenter.pdf"');
  doc.pipe(res);

  drawHeader(doc, store, title, subtitle);

  let y = doc.y;
  y = drawTableRow(doc, columns, y, true);

  rows.forEach((row, idx) => {
    const mapped = columns.map((col, cIdx) => ({
      ...col,
      text: row[cIdx],
    }));
    y = drawTableRow(doc, mapped, y, false, idx % 2 === 1);
  });

  if (summaryLines.length > 0) {
    doc.y = y + 12;
    ensureSpace(doc, 50);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1E2022');
    for (const line of summaryLines) {
      doc.text(line, 40, doc.y + 3, { width: 515, align: 'right' });
    }
  }

  doc.end();
}

module.exports = {
  generateWithdrawalReceiptPDF,
  generateOrderPDF,
  generateReportPDF,
};
