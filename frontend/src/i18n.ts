// Bulgarian translation dictionaries for API-returned enum values.
// Use the helper functions (t.*) in components instead of raw values.

export const STATUS_BG: Record<string, string> = {
  extracted:    'Извлечен',
  review_needed:'За преглед',
  confirmed:    'Потвърден',
  paid:         'Платен',
  rejected:     'Отхвърлен',
  pending:      'Изчакващ',
};

export const DIRECTION_BG: Record<string, string> = {
  incoming: 'Входящ',
  outgoing: 'Изходящ',
};

export const INVOICE_TYPE_BG: Record<string, string> = {
  invoice:     'Фактура',
  proforma:    'Проформа',
  credit_note: 'Кредитно известие',
};

export const CONTRACT_DOC_TYPE_BG: Record<string, string> = {
  contract:  'Договор',
  amendment: 'Анекс',
  annex:     'Приложение',
};

export const CONTRACT_TYPE_BG: Record<string, string> = {
  services:   'Услуги',
  rental:     'Наем',
  supply:     'Доставка',
  employment: 'Трудов',
  nda:        'NDA',
  framework:  'Рамков',
  other:      'Друг',
};

// Computed display status for confirmed contracts based on endDate
export function contractActivityLabel(endDate?: string | null): { label: string; color: string } {
  if (!endDate) return { label: 'Безсрочен', color: 'blue' };
  const end  = new Date(endDate);
  const now  = new Date();
  const diff = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 0)  return { label: 'Изтекъл',      color: 'red' };
  if (diff <= 30) return { label: 'Изтича скоро', color: 'orange' };
  return { label: 'Активен', color: 'green' };
}

// Shorthand helpers
export const t = {
  status:          (s: string) => STATUS_BG[s]            ?? s,
  direction:       (d: string) => DIRECTION_BG[d]         ?? d,
  invoiceType:     (v: string) => INVOICE_TYPE_BG[v]      ?? v,
  contractDocType: (v: string) => CONTRACT_DOC_TYPE_BG[v] ?? v,
  contractType:    (v: string) => CONTRACT_TYPE_BG[v]     ?? v,
};
