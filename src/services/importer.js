const ExcelJS = require('exceljs');
const { parseCurrencyToCents } = require('../utils/format');

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

async function parseSpreadsheetBuffer(filename, buffer) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    let text = buffer.toString('utf8');
    // Fallback for Windows-1252 / Latin1 CSVs from Brazilian ERPs
    if (text.includes('\uFFFD')) {
      text = buffer.toString('latin1');
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];
    const firstLine = lines[0];
    const semiCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semiCount >= commaCount ? ';' : ',';

    const headers = parseCSVLine(firstLine, delimiter).map(normalizeHeader);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i], delimiter);
      const obj = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = vals[idx] ?? '';
      });
      rows.push(obj);
    }
    return rows;
  }

  // Excel (.xlsx)
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) return [];

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.text || cell.value);
  });

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    let hasValue = false;
    headers.forEach((h, colNumber) => {
      if (!h) return;
      const cell = row.getCell(colNumber);
      let val = cell.value;
      if (val && typeof val === 'object') {
        if (val.result !== undefined) val = val.result;
        else if (val.text !== undefined) val = val.text;
        else val = cell.text;
      }
      const str = val === null || val === undefined ? '' : String(val).trim();
      if (str !== '') hasValue = true;
      obj[h] = str;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

function pickField(obj, candidates) {
  for (const key of candidates) {
    if (obj[key] !== undefined && String(obj[key]).trim() !== '') {
      return String(obj[key]).trim();
    }
  }
  return '';
}

function mapProductRow(obj) {
  const internal_code = pickField(obj, [
    'codigo_interno',
    'codigo',
    'cod',
    'cod_interno',
    'referencia',
    'ref',
    'sku',
    'id',
  ]);
  const barcode = pickField(obj, [
    'codigo_de_barras',
    'codigo_barras',
    'cod_barras',
    'barras',
    'ean',
    'gtin',
  ]);
  const description = pickField(obj, ['descricao', 'nome', 'produto', 'item', 'titulo']);
  const brand = pickField(obj, ['marca', 'fabricante']);
  const category = pickField(obj, ['categoria', 'grupo', 'secao', 'departamento']);
  const unit =
    pickField(obj, ['unidade_de_medida', 'unidade', 'unid', 'un', 'um', 'medida']) ||
    'unidade';
  const priceRaw = pickField(obj, [
    'preco_de_venda',
    'preco_venda',
    'preco',
    'valor',
    'vlr_venda',
    'valor_venda',
  ]);
  const statusRaw = pickField(obj, ['situacao', 'status', 'ativo']).toLowerCase();
  const status =
    statusRaw === 'inativo' || statusRaw === '0' || statusRaw === 'nao' || statusRaw === 'não'
      ? 'inativo'
      : 'ativo';

  const price_cents = priceRaw ? parseCurrencyToCents(priceRaw) : 0;

  return {
    internal_code,
    barcode,
    description,
    brand,
    category,
    unit,
    price_cents,
    status,
  };
}

function mapCustomerRow(obj) {
  const name = pickField(obj, [
    'nome_ou_razao_social',
    'nome',
    'razao_social',
    'cliente',
    'nome_fantasia',
  ]);
  const document = pickField(obj, ['cpf_cnpj', 'cpf', 'cnpj', 'documento', 'doc']);
  const phone = pickField(obj, ['telefone_whatsapp', 'telefone', 'whatsapp', 'celular', 'fone']);
  const address = pickField(obj, ['endereco', 'logradouro', 'rua']);
  const notes = pickField(obj, ['observacoes', 'observacao', 'obs']);
  const statusRaw = pickField(obj, ['situacao', 'status', 'ativo']).toLowerCase();
  const status =
    statusRaw === 'inativo' || statusRaw === '0' || statusRaw === 'nao' || statusRaw === 'não'
      ? 'inativo'
      : 'ativo';

  return { name, document, phone, address, notes, status };
}

module.exports = {
  parseSpreadsheetBuffer,
  mapProductRow,
  mapCustomerRow,
};
