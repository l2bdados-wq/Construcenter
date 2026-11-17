function parseCurrencyToCents(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[R$\s]/g, '');
    if (!cleaned) return 0;
    // Handle pt-BR "1.234,56" or standard "1234.56"
    let normalized = cleaned;
    if (cleaned.includes(',')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    }
    const num = Number(normalized);
    if (!Number.isFinite(num)) return NaN;
    return Math.round(num * 100);
  }
  return NaN;
}

function parseQuantity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 1000) / 1000;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(',', '.');
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return NaN;
    return Math.round(num * 1000) / 1000;
  }
  return NaN;
}

function computeSubtotalCents(quantity, unitPriceCents) {
  return Math.round(quantity * unitPriceCents);
}

function formatCents(cents) {
  const value = (Number(cents || 0) / 100);
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatQuantity(qty) {
  const num = Number(qty || 0);
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: num % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 3,
  });
}

function formatDateTimeBR(isoStr) {
  if (!isoStr) return '';
  // Accepts 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD'
  const clean = isoStr.replace('T', ' ');
  const [datePart, timePart] = clean.split(' ');
  const parts = (datePart || '').split('-');
  if (parts.length !== 3) return isoStr;
  const brDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
  if (timePart) {
    return `${brDate} ${timePart.slice(0, 5)}`;
  }
  return brDate;
}

function formatDateBR(isoStr) {
  if (!isoStr) return '';
  const datePart = isoStr.replace('T', ' ').split(' ')[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return isoStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function nowLocalISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  parseCurrencyToCents,
  parseQuantity,
  computeSubtotalCents,
  formatCents,
  formatQuantity,
  formatDateTimeBR,
  formatDateBR,
  nowLocalISO,
};
