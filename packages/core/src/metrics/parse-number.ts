/**
 * Parseo de los números que WhatsApp Web muestra en Estadísticas.
 *
 * WA los pinta ya localizados y, por encima de 1000, ABREVIADOS:
 *
 *   es: "3225"   "2,7 mil"  "84,9 %"   "1.234"   (separador de miles ".")
 *   en: "3225"   "2.7K"     "84.9%"    "1,234"   (separador de miles ",")
 *
 * Además el espacio entre el número y el sufijo es NBSP (U+00A0), no un espacio
 * normal, así que cualquier split por " " falla si no se normaliza antes.
 *
 * OJO con la precisión: "2,7 mil" NO es 2700 exactos, es 2700 redondeado por
 * WhatsApp (el propio dump lo demuestra: alcance total 3225, pero el desglose
 * dice 2,7 mil + 486 = 3186). Por eso devolvemos `exact` y la cadena original:
 * quien consuma el JSON debe poder distinguir un dato exacto de uno redondeado.
 */

export interface ParsedNumber {
  /** Valor numérico, o null si no se pudo parsear. */
  value: number | null;
  /** true si el número venía completo; false si WA lo abrevió (mil/K/M). */
  exact: boolean;
  /** Texto tal y como lo pinta WhatsApp, para trazabilidad. */
  raw: string;
}

/**
 * Sufijos de magnitud por idioma. El orden importa: "mill" antes que "mil".
 *
 * Los sufijos ingleses van PEGADOS al número ("2.7K"), así que no sirve `\bK\b`:
 * entre "7" y "K" no hay frontera de palabra y nunca matchearía. Se ancla al
 * final exigiendo un dígito delante, con espacio opcional ("1,2 M").
 */
const MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bmill(?:ones|ón|on)?\b\.?/i, 1_000_000],
  [/\bmil\b\.?/i, 1_000],
  [/\d\s*(?:bn|B)$/, 1_000_000_000],
  [/\d\s*M$/, 1_000_000],
  [/\d\s*K$/i, 1_000],
];

/**
 * Decide si "," o "." es separador decimal o de miles.
 *
 * Heurística estándar: si solo aparece un separador y le siguen exactamente 3
 * dígitos, es de miles ("1.234" = 1234). En cualquier otro caso es decimal
 * ("2,7" = 2.7). Con ambos presentes, el último es el decimal ("1.234,5").
 */
function toPlainNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    normalized = cleaned.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? ',' : '.';
    const [head, ...rest] = cleaned.split(sep);
    const tail = rest.join('');
    // Un único separador seguido de 3 dígitos ⇒ miles.
    normalized = rest.length === 1 && tail.length === 3 ? `${head}${tail}` : `${head}.${tail}`;
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Parsea un número de la UI de WhatsApp (es/en, abreviado o no). */
export function parseWaNumber(raw: string): ParsedNumber {
  // NBSP y narrow-NBSP → espacio normal antes de cualquier otra cosa.
  const text = raw.replace(/[  ]/g, ' ').trim();
  if (text === '') return { value: null, exact: false, raw };

  let multiplier = 1;
  for (const [pattern, factor] of MULTIPLIERS) {
    if (pattern.test(text)) {
      multiplier = factor;
      break;
    }
  }

  const base = toPlainNumber(text);
  if (base === null) return { value: null, exact: false, raw };

  const value = multiplier === 1 ? base : Math.round(base * multiplier);
  return { value, exact: multiplier === 1, raw };
}

/** Parsea un porcentaje ("84,9 %" → 84.9). Devuelve null si no hay número. */
export function parseWaPercent(raw: string): number | null {
  return parseWaNumber(raw).value;
}
