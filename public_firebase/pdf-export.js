(function () {
  let cachedLogoDataUrl = null;

  async function getLogoDataUrl() {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    try {
      const res = await fetch('/logo.jpeg');
      const blob = await res.blob();
      cachedLogoDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return cachedLogoDataUrl;
    } catch (_) {
      return null;
    }
  }

  function fmtCents(c) {
    return (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtQty(q) {
    const n = Number(q || 0);
    return n.toLocaleString('pt-BR', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 3,
    });
  }

  function fmtDateTime(str) {
    if (!str) return '';
    const clean = String(str).replace('T', ' ');
    const [d, t] = clean.split(' ');
    const parts = (d || '').split('-');
    if (parts.length !== 3) return str;
    return `${parts[2]}/${parts[1]}/${parts[0]}${t ? ' ' + t.slice(0, 5) : ''}`;
  }

  function fmtDate(str) {
    if (!str) return '';
    const d = String(str).replace('T', ' ').split(' ')[0];
    const parts = d.split('-');
    if (parts.length !== 3) return str;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  async function drawPdfHeader(doc, store, rightTitle, rightSubtitle) {
    const logo = await getLogoDataUrl();
    if (logo) {
      doc.addImage(logo, 'JPEG', 14, 10, 32, 20);
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 32, 34);
    doc.text(rightTitle, 196, 16, { align: 'right' });

    if (rightSubtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(90, 90, 90);
      doc.text(rightSubtitle, 196, 22, { align: 'right' });
    }

    const storeLine = [
      store?.name || 'CONSTRUCENTER',
      store?.cnpj ? `CNPJ: ${store.cnpj}` : '',
      store?.phone ? `Tel/WhatsApp: ${store.phone}` : '',
      store?.address || '',
    ]
      .filter(Boolean)
      .join('  •  ');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(70, 70, 70);
    doc.text(storeLine, 14, 34, { maxWidth: 182 });

    doc.setDrawColor(230, 138, 46);
    doc.setLineWidth(0.7);
    doc.line(14, 38, 196, 38);
    return 44;
  }

  window.exportWithdrawalReceiptPDF = async function (w, store) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    let y = await drawPdfHeader(
      doc,
      store,
      `COMPROVANTE DE RETIRADA ${w.code}`,
      `Situação: ${String(w.status || '').toUpperCase()}  •  Documento sem valor fiscal`
    );

    doc.setDrawColor(210, 214, 220);
    doc.roundedRect(14, y, 182, 26, 2, 2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 32, 34);
    doc.text(`Cliente: ${w.customer_name}`, 18, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`CPF/CNPJ: ${w.customer_document || 'Não informado'}`, 18, y + 11.5);
    doc.text(`Obra/Ref.: ${w.work_reference || 'Não informada'}`, 18, y + 17);
    doc.text(`Retirado por: ${w.picked_up_by}`, 18, y + 22.5);

    doc.text(`Data/Hora: ${fmtDateTime(w.withdrawal_date)}`, 192, y + 6, { align: 'right' });
    doc.text(`Atendente: ${w.employee_name}`, 192, y + 11.5, { align: 'right' });
    if (w.order_number) {
      doc.text(`Pedido: ${w.order_number}`, 192, y + 17, { align: 'right' });
    }

    y += 31;

    doc.autoTable({
      startY: y,
      head: [['Código', 'Descrição', 'Unid.', 'Qtd.', 'V. Unit.', 'Subtotal']],
      body: (w.items || []).map((it) => [
        it.product_code,
        it.product_description,
        it.product_unit,
        fmtQty(it.quantity),
        fmtCents(it.unit_price_cents),
        fmtCents(it.subtotal_cents),
      ]),
      styles: { fontSize: 8.5, cellPadding: 2.5 },
      headStyles: { fillColor: [30, 32, 34] },
      columnStyles: {
        2: { halign: 'center' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });

    y = doc.lastAutoTable.finalY + 6;

    if (w.returns && w.returns.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(185, 28, 28);
      doc.text('Devoluções Registradas:', 14, y);
      y += 4.5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(50, 50, 50);
      for (const ret of w.returns) {
        doc.text(
          `• ${fmtDateTime(ret.returned_at)} - ${ret.product_description}: Qtd ${fmtQty(ret.quantity)} (${fmtCents(ret.refund_cents)}) — Motivo: ${ret.reason}`,
          16,
          y
        );
        y += 4.5;
      }
      y += 2;
    }

    if (w.notes) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(60, 60, 60);
      doc.text(`Observações: ${w.notes}`, 14, y, { maxWidth: 110 });
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    doc.text(`Subtotal dos Itens: ${fmtCents(w.items_subtotal_cents)}`, 196, y, { align: 'right' });
    if (w.returns_total_cents > 0) {
      y += 5;
      doc.text(`(-) Devoluções: ${fmtCents(w.returns_total_cents)}`, 196, y, { align: 'right' });
    }
    if (w.discount_cents > 0) {
      y += 5;
      doc.text(`(-) Desconto: ${fmtCents(w.discount_cents)}`, 196, y, { align: 'right' });
    }
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`TOTAL DA RETIRADA: ${fmtCents(w.net_total_cents)}`, 196, y, { align: 'right' });

    const sigY = Math.max(y + 24, 245);
    doc.setDrawColor(60, 60, 60);
    doc.setLineWidth(0.3);
    doc.line(22, sigY, 96, sigY);
    doc.line(114, sigY, 188, sigY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`Assinatura: ${w.picked_up_by}`, 59, sigY + 5, { align: 'center' });
    doc.text(`Funcionário: ${w.employee_name}`, 151, sigY + 5, { align: 'center' });

    window.open(doc.output('bloburl'), '_blank');
  };

  window.exportOrderPDF = async function (orderData, store, mode = 'consolidated') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    let y = await drawPdfHeader(
      doc,
      store,
      `PEDIDO ${orderData.order_number}`,
      `Pedido — sem valor fiscal  •  Emissão: ${fmtDateTime(orderData.issued_at)}`
    );

    doc.setFillColor(254, 243, 199);
    doc.roundedRect(14, y, 182, 7, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(146, 64, 14);
    doc.text('PEDIDO — SEM VALOR FISCAL', 105, y + 4.8, { align: 'center' });
    y += 10;

    doc.setDrawColor(210, 214, 220);
    doc.roundedRect(14, y, 182, 24, 2, 2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 32, 34);
    doc.text(`Cliente: ${orderData.customer.name}`, 18, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`CPF/CNPJ: ${orderData.customer.document || 'Não informado'}`, 18, y + 11.5);
    doc.text(`Telefone: ${orderData.customer.phone || 'Não informado'}`, 18, y + 17);
    doc.text(`Endereço: ${orderData.customer.address || 'Não informado'}`, 18, y + 22, { maxWidth: 100 });

    doc.text(`Período: ${fmtDate(orderData.period_start)} a ${fmtDate(orderData.period_end)}`, 192, y + 6, { align: 'right' });
    doc.text(`Cond. Pagamento: ${orderData.payment_condition || 'A combinar'}`, 192, y + 11.5, { align: 'right' });
    doc.text(`Vencimento: ${orderData.due_date ? fmtDate(orderData.due_date) : 'Não informado'}`, 192, y + 17, { align: 'right' });
    doc.text(`Retiradas: ${orderData.withdrawals.map((w) => w.code).join(', ')}`, 192, y + 22, { align: 'right', maxWidth: 78 });

    y += 30;

    if (mode === 'consolidated' || mode === 'both') {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 32, 34);
      doc.text('Resumo Consolidado dos Produtos', 14, y);
      y += 3;

      doc.autoTable({
        startY: y,
        head: [['Código', 'Descrição', 'Unid.', 'Qtd. Total', 'V. Unit.', 'Total']],
        body: orderData.consolidated_items.map((it) => [
          it.product_code,
          it.product_description,
          it.product_unit,
          fmtQty(it.quantity),
          fmtCents(it.unit_price_cents),
          fmtCents(it.subtotal_cents),
        ]),
        styles: { fontSize: 8.5, cellPadding: 2.5 },
        headStyles: { fillColor: [30, 32, 34] },
        columnStyles: {
          2: { halign: 'center' },
          3: { halign: 'right' },
          4: { halign: 'right' },
          5: { halign: 'right' },
        },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    if (mode === 'detailed' || mode === 'both') {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 32, 34);
      doc.text('Detalhamento das Retiradas por Data', 14, y);
      y += 5;

      for (const w of orderData.withdrawals) {
        if (y > 250) {
          doc.addPage();
          y = 18;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(230, 138, 46);
        doc.text(
          `${w.code}  •  ${fmtDateTime(w.withdrawal_date)}  •  Retirado por: ${w.picked_up_by}${w.work_reference ? `  •  Obra: ${w.work_reference}` : ''}`,
          14,
          y
        );
        y += 2.5;

        doc.autoTable({
          startY: y,
          head: [['Código', 'Descrição', 'Unid.', 'Qtd.', 'V. Unit.', 'Subtotal']],
          body: (w.items || []).map((it) => [
            it.product_code,
            it.product_description,
            it.product_unit,
            fmtQty(it.quantity),
            fmtCents(it.unit_price_cents),
            fmtCents(it.subtotal_cents),
          ]),
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [30, 32, 34] },
          columnStyles: {
            2: { halign: 'center' },
            3: { halign: 'right' },
            4: { halign: 'right' },
            5: { halign: 'right' },
          },
          margin: { left: 14, right: 14 },
        });
        y = doc.lastAutoTable.finalY + 4;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(70, 70, 70);
        doc.text(`Líquido da retirada: ${fmtCents(w.net_total_cents)}`, 196, y, { align: 'right' });
        y += 6;
      }
    }

    if (y > 255) {
      doc.addPage();
      y = 18;
    }
    doc.setDrawColor(210, 214, 220);
    doc.line(14, y, 196, y);
    y += 6;

    if (orderData.notes) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(60, 60, 60);
      doc.text(`Observações: ${orderData.notes}`, 14, y, { maxWidth: 105 });
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    doc.text(`Subtotal Bruto: ${fmtCents(orderData.subtotal_cents)}`, 196, y, { align: 'right' });
    if (orderData.returns_cents > 0) {
      y += 5;
      doc.text(`(-) Devoluções: ${fmtCents(orderData.returns_cents)}`, 196, y, { align: 'right' });
    }
    if (orderData.discount_cents > 0) {
      y += 5;
      doc.text(`(-) Descontos: ${fmtCents(orderData.discount_cents)}`, 196, y, { align: 'right' });
    }
    y += 6.5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(30, 32, 34);
    doc.text(`TOTAL GERAL: ${fmtCents(orderData.total_cents)}`, 196, y, { align: 'right' });

    window.open(doc.output('bloburl'), '_blank');
  };

  window.exportReportPDF = async function ({ title, subtitle, headers, rows, summaryLines = [], store }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let y = await drawPdfHeader(doc, store, title, subtitle);

    doc.autoTable({
      startY: y,
      head: [headers],
      body: rows,
      styles: { fontSize: 8.5, cellPadding: 2.5 },
      headStyles: { fillColor: [30, 32, 34] },
      margin: { left: 14, right: 14 },
    });

    y = doc.lastAutoTable.finalY + 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    for (const line of summaryLines) {
      doc.text(line, 196, y, { align: 'right' });
      y += 5;
    }

    window.open(doc.output('bloburl'), '_blank');
  };
})();
