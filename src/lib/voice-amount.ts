export type VoiceCharge = { amountCents: number; concept: string };

const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const small: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90,
};
const hundreds: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
  trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500,
  quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900,
  novecientas: 900,
};
const numberWord = (word: string) => Object.hasOwn(small, word) || Object.hasOwn(hundreds, word) || word === "mil" || word === "y";
const unsupportedMagnitude = /^(?:millon(?:es)?|billon(?:es)?|trillon(?:es)?|cuatrillon(?:es)?|miles|millar(?:es)?|cientos|punto|coma)(?:\b|$)/;
const negative = /^(?:[-−–+]|menos\b|negativ[oa]\b)/i;

function underHundred(words: string[]): number | null {
  if (words.length === 1 && Object.hasOwn(small, words[0])) return small[words[0]];
  if (words.length === 3 && words[1] === "y") {
    const tens = small[words[0]], units = small[words[2]];
    if (tens >= 30 && tens % 10 === 0 && units >= 1 && units <= 9) return tens + units;
  }
  return null;
}

function underThousand(words: string[]): number | null {
  if (Object.hasOwn(hundreds, words[0])) {
    if (words.length === 1) return words[0] === "ciento" ? null : hundreds[words[0]];
    if (words[0] === "cien") return null;
    const tail = underHundred(words.slice(1));
    return tail !== null && tail > 0 ? hundreds[words[0]] + tail : null;
  }
  return underHundred(words);
}

function wordsValue(words: string[]): number | null {
  const at = words.indexOf("mil");
  if (at === -1) return underThousand(words);
  if (words.lastIndexOf("mil") !== at) return null;
  const multiplier = at === 0 ? 1 : underThousand(words.slice(0, at));
  // Spanish uses "mil", rather than "uno mil". Supported word amounts stop at 999,999.
  if (multiplier === null || (at > 0 && multiplier <= 1)) return null;
  if (at === words.length - 1) return multiplier * 1000;
  const rest = underThousand(words.slice(at + 1));
  return rest !== null && rest > 0 ? multiplier * 1000 + rest : null;
}

type ParsedNumber = { cents: bigint; end: number; fractional: boolean };
function readNumber(text: string): ParsedNumber | null {
  if (/^\d/.test(text)) {
    const raw = text.match(/^\d[\d.,]*/)?.[0];
    if (!raw || raw.length > 64) return null;
    let token = raw;
    // A final comma/period followed by whitespace is sentence punctuation, not rounding.
    if (/[,.]$/.test(token) && (text.length === raw.length || /\s/.test(text[raw.length]))) token = token.slice(0, -1);
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(token)) return null;
    const [whole, decimal = ""] = token.replace(/,/g, "").split(".");
    const next = text.slice(raw.length);
    if (next && !/^[\s,.;:!?)]/.test(next) && !/^(?:pesos?|varos?|mxn|centavos?)\b/i.test(next)) return null;
    return { cents: BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0")), end: raw.length, fractional: decimal.length > 0 };
  }
  const words: string[] = [];
  let end = 0;
  while (end < text.length) {
    const gap = text.slice(end).match(/^\s*/)?.[0].length || 0;
    const match = text.slice(end + gap).match(/^[\p{L}]+/u);
    if (!match) break;
    const word = fold(match[0]);
    if (!numberWord(word)) break;
    words.push(word);
    end += gap + match[0].length;
    // Punctuation terminates an amount; it cannot join two numeric phrases.
    if (end < text.length && !/\s/.test(text[end])) break;
  }
  if (!words.length) return null;
  const value = wordsValue(words);
  return value === null ? null : { cents: BigInt(value) * 100n, end, fractional: false };
}

function startsNumber(text: string): boolean {
  if (/^\d/.test(text)) return true;
  const word = fold(text.match(/^[\p{L}]+/u)?.[0] || "");
  return numberWord(word) || unsupportedMagnitude.test(word) || /^(?:menos|negativ[oa])$/.test(word);
}

function cleanConcept(text: string): string {
  return text.replace(/^[\s,.;:!?¿¡\-–—"“”'()[\]]+|[\s,.;:!?¿¡"“”'()[\]]+$/g, "")
    .replace(/\s+/g, " ").slice(0, 100).trim();
}

/** Parse a leading Mexican Spanish amount. It never authorizes or creates a charge.
 * Decimal separator is a dot; commas are accepted only as complete thousands groups.
 * Unsupported magnitudes and ambiguous adjacent amounts fail instead of guessing.
 */
function parseLeadingVoiceCharge(text: string): VoiceCharge | null {
  if (typeof text !== "string" || text.length > 2000) return null;
  let source = text.normalize("NFC").trim().replace(/^[¿¡"“”'(\[]+\s*/, "");
  source = source.replace(/^(?:(?:cobra|c[oó]brale|son|es)\b[\s,:;]*)+/iu, "");
  source = source.replace(/^[¿¡"“”'(\[]+\s*/, "");
  if (negative.test(fold(source))) return null;
  source = source.replace(/^(?:\$\s*|(?:mxn|pesos?|varos?)\s+)/i, "");
  if (negative.test(fold(source))) return null;
  const first = readNumber(source);
  if (!first) return null;
  let cents = first.cents;
  let rest = source.slice(first.end).trimStart();

  const centsOnly = rest.match(/^centavos?\b/i);
  if (centsOnly) {
    if (first.fractional || cents / 100n > 99n) return null;
    cents /= 100n;
    rest = rest.slice(centsOnly[0].length).trimStart();
  } else {
    const currency = rest.match(/^(?:pesos?(?:\s+mexicanos)?|varos?|mxn)\b/i);
    if (currency) rest = rest.slice(currency[0].length).trimStart();
    const connector = rest.match(/^(?:con|y)\s+/i);
    const possibleCents = connector ? rest.slice(connector[0].length) : rest;
    if (startsNumber(possibleCents)) {
      if (first.fractional || (!currency && !connector)) return null;
      const fraction = readNumber(possibleCents);
      if (!fraction || fraction.fractional || fraction.cents / 100n > 99n) return null;
      const tail = possibleCents.slice(fraction.end).trimStart();
      const marker = tail.match(/^centavos?\b/i);
      if (!marker) return null;
      cents += fraction.cents / 100n;
      rest = tail.slice(marker[0].length).trimStart();
    }
  }

  const concept = cleanConcept(rest);
  // A separator must not turn malformed/adjacent numbers into a plausible concept.
  if (startsNumber(concept) || negative.test(fold(concept))
    || /^(?:y|con)\s+/i.test(concept) && startsNumber(concept.replace(/^(?:y|con)\s+/i, ""))) return null;
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { amountCents: Number(cents), concept };
}

/** Accept concept-first speech only when a single complete amount ends the phrase.
 * Leading amounts retain the original grammar; failed numeric phrases never fall back.
 * This remains a suggestion for the editable form, never payment authorization.
 */
export function parseVoiceCharge(text: string): VoiceCharge | null {
  if (typeof text !== "string" || text.length > 2000) return null;
  let source = text.normalize("NFC").trim().replace(/^[¿¡"“”'(\[]+\s*/, "");
  source = source.replace(/^(?:(?:cobra|c[oó]brale|son|es)\b[\s,:;]*)+/iu, "")
    .replace(/^[¿¡"“”'(\[]+\s*/, "");

  // A numeric/monetary/negative start belongs exclusively to the established parser.
  if (startsNumber(source) || negative.test(fold(source))
    || /^(?:\$|mxn\b|pesos?\b|varos?\b)/i.test(source)) return parseLeadingVoiceCharge(text);

  const candidates: VoiceCharge[] = [];
  for (const boundary of source.matchAll(/\s+/g)) {
    const at = boundary.index + boundary[0].length;
    const prefix = source.slice(0, boundary.index);
    const suffix = source.slice(at);
    const words = fold(prefix).match(/[\p{L}]+/gu) || [];
    // Do not turn quantities, alternatives, phone fragments or malformed numbers
    // embedded in the concept into a different, apparently valid final price.
    if (/\d|[$+−–]/u.test(prefix) || /-\s*$/.test(prefix) || words.some(word =>
      (word !== "y" && numberWord(word)) || unsupportedMagnitude.test(word)
      || /^(?:menos|negativ[oa]|o)$/.test(word))) continue;
    // An ungrouped ten-or-more digit tail is ambiguous with a phone/account number.
    // Longer explicit amount-first input still follows the original exact parser.
    if (/^(?:\$\s*)?\d{10,}(?=\D|$)/.test(suffix)) continue;
    const parsed = parseLeadingVoiceCharge(suffix);
    if (!parsed || parsed.concept !== "") continue;
    let concept = cleanConcept(prefix);
    concept = concept.replace(/(?:\s+\b(?:por|cuesta|de)\b[\s,.;:]*)+$/iu, "").trim();
    if (!concept || !/[\p{L}]/u.test(concept)) continue;
    candidates.push({ amountCents: parsed.amountCents, concept });
  }
  return candidates.length === 1 ? candidates[0] : null;
}
