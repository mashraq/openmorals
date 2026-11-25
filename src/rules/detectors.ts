/**
 * Named detectors for rules (0.16.0): `match.detector` names one or more, and the rule fires when one of them finds its
 * pattern in the text the action carries. Each detector is a fixed shape plus a checksum or validity rule, written as a
 * single pass over the text (no regular expression with an unbounded repeat), so its time is linear in the text.
 *
 * These find LIKELY patterns. A hit says the text holds something with the shape and checksum below; it does not say the
 * value is real, belongs to a person, or is personal or health data, and a miss says nothing about what else the text
 * holds. Nothing a detector finds is kept: the caller gets a count.
 */
import { TOKEN_PATTERNS } from '../scanner/redact.js';
import type { Rule } from '../types.js';

/** Where a hit is in the text: [start, end). */
export type Span = readonly [number, number];

export const DETECTOR_NAMES = ['secret-token', 'card-number', 'iban', 'us-ssn', 'nhs-number', 'email', 'phone-e164', 'hl7-msh', 'fhir-patient'] as const;

export type DetectorName = (typeof DETECTOR_NAMES)[number];

/** A count above this is reported as this number: the search stops there. */
export const MAX_DETECTOR_HITS = 1000;

/** How far before a bare (unformatted) number its label may stand, in characters. */
export const LABEL_WINDOW = 40;

export function isDetectorName(v: unknown): v is DetectorName {
  return typeof v === 'string' && (DETECTOR_NAMES as readonly string[]).includes(v);
}

export interface DetectorInfo {
  name: DetectorName;
  fires: string;
  doesNotFire: string;
  misses: string;
}

/** What each detector fires on, what it does not, and what it misses (the rules doc's table is written from this). */
export const DETECTORS: readonly DetectorInfo[] = Object.freeze([
  {
    name: 'secret-token',
    fires: 'vendor token shapes the redactor knows (TOKEN_PATTERNS): sk-..., ghp_/gho_/ghu_/ghs_/ghr_..., github_pat_..., xox?-..., AKIA/ASIA + 16, AIza..., glpat-..., npm_...',
    doesNotFire: 'a placeholder such as <your token>, or a shape not in the list',
    misses: 'passwords, private keys (use a content rule), JWTs, tokens of other vendors, and any token split, encoded or compressed',
  },
  {
    name: 'card-number',
    fires: '13 to 19 digits starting with 2 to 6, written together or in groups (4-4-4-4, 4-4-4-1..4, 4-4-4-4-1..3, 4-6-5, 4-6-4) with one kind of space or dash, passing the Luhn check',
    doesNotFire: "a published test card number (Stripe's test list and the common sandbox numbers), a number failing Luhn, a number inside a longer number or word, a number after +",
    misses: 'numbers in other groupings, numbers split over lines or fields, numbers starting with 1, 7, 8 or 9, and any number that is encoded; about 1 in 10 random 13-19 digit numbers starting 2-6 passes Luhn, so it also fires on some ids',
  },
  {
    name: 'iban',
    fires: 'a country code from the IBAN length table (capitals), two check digits, then the country length of letters and digits, together or in groups of four, passing mod-97',
    doesNotFire: 'a wrong length for the country, a failing check, a lower-case country code',
    misses: 'countries not in the table, other groupings, account numbers that are not IBANs; the standard documentation examples pass mod-97 and fire',
  },
  {
    name: 'us-ssn',
    fires: 'AAA-GG-SSSS or AAA GG SSSS (one kind of separator), or nine digits with "ssn" or "social security" in the 40 characters before, where the area is not 000, 666 or 900-999, the group is not 00 and the serial is not 0000',
    doesNotFire: 'numbers breaking those rules, a bare nine-digit number with no label, the shape inside a longer run such as 1-123-45-6789-2',
    misses: 'unlabelled bare numbers and other formats; it cannot tell an issued number from an unissued one, so placeholders such as 123-45-6789 fire',
  },
  {
    name: 'nhs-number',
    fires: 'ten digits as 3-3-4 with one kind of space or dash, or ten digits with "nhs" in the 40 characters before, passing the modulus 11 check',
    doesNotFire: 'a failing check digit, a bare ten-digit number with no label, the shape inside a longer run',
    misses: 'unlabelled bare numbers and other groupings; about 1 in 11 random ten-digit numbers passes the check, so some 3-3-4 phone numbers fire; test-range numbers are not exempted (no authoritative reserved range was found)',
  },
  {
    name: 'email',
    fires: 'local@domain with a dotted domain and a letter top-level domain, outside the reserved names (example.com/.net/.org and the .example, .test, .invalid and .localhost top-level domains)',
    doesNotFire: 'reserved names, user@host:path (an ssh or git remote), @scope/package, a single-label host',
    misses: 'obfuscated addresses (name at domain dot com), addresses with quoted local parts or non-ASCII characters',
  },
  {
    name: 'phone-e164',
    fires: '+ then a digit 1-9 and 8 to 15 digits in all, together or with single spaces, dashes or dots between groups',
    doesNotFire: 'numbers without +, more than 15 digits, the fictional ranges (North American 555-0100 to 555-0199, the UK drama ranges such as 020 7946 0xxx and 07700 900xxx)',
    misses: 'national formats without +, numbers with brackets or extensions; it also fires on some sums written as +12345678',
  },
  {
    name: 'hl7-msh',
    fires: 'an HL7 version 2 message header: MSH at a line start (or after a quote or space), a field separator, four or five encoding characters, the separator again',
    doesNotFire: 'MSH in running text, other segments alone',
    misses: 'HL7 version 3 and CDA documents, messages whose MSH segment is not in the text (cut, or only later segments)',
  },
  {
    name: 'fhir-patient',
    fires: 'a FHIR Patient resource: "resourceType": "Patient" in JSON, or <Patient ... xmlns="http://hl7.org/fhir"> in XML',
    doesNotFire: 'other resource types, the word Patient alone',
    misses: 'patient data in other resources (Observation, Encounter ...), in other formats, or with the resourceType elsewhere in a cut text',
  },
]);

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}

function isLetter(c: number): boolean {
  return isUpper(c) || (c >= 97 && c <= 122);
}

function isAlnum(c: number): boolean {
  return isDigit(c) || isLetter(c);
}

function isWord(c: number): boolean {
  return isAlnum(c) || c === 95;
}

/** True when a number may start at `i`: not inside a word, not after a decimal point or a + sign. */
function startsClean(s: string, i: number): boolean {
  if (i === 0) return true;
  const p = s.charCodeAt(i - 1);
  if (isWord(p) || p === 43) return false;
  if (p === 46 && i >= 2 && isDigit(s.charCodeAt(i - 2))) return false;
  return true;
}

/** True when a number may end at `j` (exclusive): not followed by a word character or a decimal part. */
function endsClean(s: string, j: number): boolean {
  if (j >= s.length) return true;
  const c = s.charCodeAt(j);
  if (isWord(c)) return false;
  if (c === 46 && j + 1 < s.length && isDigit(s.charCodeAt(j + 1))) return false;
  return true;
}

interface Run {
  /** The digit groups, in order. */
  groups: string[];
  /** Start index in the text of each group. */
  starts: number[];
  /** The one separator used between groups (space or dash), or null for a single group. */
  sep: number | null;
  /** Index after the run. */
  end: number;
}

/** A run of digit groups from `i` (a digit), joined by one kind of separator (a single space or dash, the same each time). */
function readRun(s: string, i: number): Run {
  const n = s.length;
  const groups: string[] = [];
  const starts: number[] = [];
  let sep: number | null = null;
  let j = i;
  for (;;) {
    const from = j;
    while (j < n && isDigit(s.charCodeAt(j))) j++;
    groups.push(s.slice(from, j));
    starts.push(from);
    if (j + 1 < n) {
      const c = s.charCodeAt(j);
      if ((c === 32 || c === 45) && (sep === null || sep === c) && isDigit(s.charCodeAt(j + 1))) {
        sep = c;
        j++;
        continue;
      }
    }
    break;
  }
  return { groups, starts, sep, end: j };
}

/** Calls `visit` for every run of digit groups that starts clean, in order; `visit` returns how many hits it found (stops at the cap). */
function eachRun(s: string, visit: (r: Run) => number): number {
  const n = s.length;
  let hits = 0;
  let i = 0;
  while (i < n) {
    if (!isDigit(s.charCodeAt(i))) {
      i++;
      continue;
    }
    if (!startsClean(s, i)) {
      while (i < n && isDigit(s.charCodeAt(i))) i++;
      continue;
    }
    const r = readRun(s, i);
    hits += visit(r);
    if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
    i = r.end;
  }
  return hits;
}

/**
 * Counts windows of consecutive groups in a run whose lengths are one of `shapes`, ending clean, for which `ok` holds on
 * the joined digits. A window that hits is skipped past. A single-group shape is tried only on a group that is the whole
 * run or sits between separators.
 */
function countShapes(s: string, r: Run, shapes: readonly (readonly number[])[], ok: (digits: string, start: number) => boolean, out?: Span[]): number {
  let hits = 0;
  let a = 0;
  const g = r.groups;
  while (a < g.length) {
    let hit = 0;
    for (const shape of shapes) {
      if (a + shape.length > g.length) continue;
      let fits = true;
      for (let k = 0; k < shape.length; k++) {
        if ((g[a + k] ?? '').length !== shape[k]) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      const last = a + shape.length - 1;
      const end = (r.starts[last] ?? 0) + (g[last] ?? '').length;
      if (last === g.length - 1 ? !endsClean(s, end) : false) continue;
      const digits = g.slice(a, last + 1).join('');
      if (ok(digits, r.starts[a] ?? 0)) {
        hit = shape.length;
        out?.push([r.starts[a] ?? 0, end]);
        break;
      }
    }
    if (hit > 0) {
      hits++;
      a += hit;
    } else a++;
  }
  return hits;
}

function labelBefore(s: string, start: number, labels: readonly string[]): boolean {
  const before = s.slice(Math.max(0, start - LABEL_WINDOW), start).toLowerCase();
  return labels.some((l) => before.includes(l));
}

// ---- secret-token ---------------------------------------------------------------------------------------------------

const TOKENS: readonly RegExp[] = TOKEN_PATTERNS.map((p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`));

function secretTokens(s: string, out?: Span[]): number {
  let hits = 0;
  for (const re of TOKENS) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      out?.push([m.index, m.index + m[0].length]);
      hits++;
      if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
    }
  }
  return hits;
}

// ---- card-number ----------------------------------------------------------------------------------------------------

/** Luhn (ISO/IEC 7812-1 annex B): from the right, double every second digit, subtract 9 above 9; the sum ends in 0. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * Published test card numbers that never fire: Stripe's testing page (docs.stripe.com/testing, read 25 Nov 2026) and the
 * common sandbox numbers of other payment providers. They pass Luhn by design.
 */
export const TEST_CARD_NUMBERS: ReadonlySet<string> = new Set([
  '4242424242424242', '4000056655665556', '5555555555554444', '2223003122003222', '5200828282828210', '5105105105105100',
  '378282246310005', '371449635398431', '6011111111111117', '6011000990139424', '6011981111111113', '3056930009020004',
  '36227206271667', '6555900000604105', '3566002020360505', '6200000000000005', '6200000000000047', '6205500000000000004',
  '4000002500001001', '5555552500001001', '4000050360000001', '5555050360000080',
  '4000000320000021', '4000000760000002', '4000001240000000', '4000001520000001', '4000001700000003', '4000001880000005',
  '4000002180000000', '4000004840008001', '5062210000000009', '4000005910000000', '4000006000000066', '4000006040000068',
  '4000008580000003', '4000007840000001', '5200007840000022', '4000000400000008', '4000000560000004', '4000001000000000',
  '4000001120000005', '4000001910000009', '4000001960000008', '4000002030000002', '4000002080000001', '4000002330000009',
  '4000002460000001', '4000002500000003', '4000002760000016', '4000002920000005', '4000003000000030', '4000003480000005',
  '4000003720000005', '4000003800000008', '4000004280000005', '4000004380000004', '4000004400000000', '4000004420000006',
  '4000004700000007', '4000005280000002', '4000005780000007', '4000006160000005', '4000006200000007', '4000006420000001',
  '4000006820000007', '4000007050000006', '4000007030000001', '4000007240000007', '4000007520000008', '4000007560000009',
  '4000008260000000', '4000058260000005', '5555558265554449', '4000000360000006', '4000001560000002', '4000003440000004',
  '4000003560000008', '4000003920000003', '3530111333300000', '4000004580000002', '4000005540000008', '4000007020000003',
  '4000001580000008', '4000007640000003', '4000057640000008', '4000051230000072', '5200828282828897',
  '4000000000000002', '4000000000009995', '4000000000009987', '4000000000009979', '4000000000000069', '4000000000000127',
  '4000000000000119', '4000000000006975', '4000000000000341', '4100000000000019', '4000000000004954', '4000000000009235',
  '4000008400000407', '4000008400000159', '4000008400001017', '4001858821843804', '4000008405600003', '4000000000000101',
  '4000000000000036', '4000058400307872', '4000058400306072', '4000000000000028', '4000000000000010', '4000000000000044',
  '4061219946393810', '4000000000000259', '6026507838377928', '4000000000002685', '4000000000001976', '4000000000005423',
  '4000000404000079', '4000000404000038', '4000008400000779', '5105008400000002', '4000000001000043', '4000008400000795',
  '4000000404004816', '4000000404005649', '5105000300000018', '4000000000007726', '4000000000005126', '4000000000000077',
  '4000003720000278', '4000000000003220', '4000008400000027', '4000008400001629', '4000008400001280', '4000000000003055',
  '4000000000003097', '4000000032200000', '4000002500003155', '4000002760003184', '4000003800000446', '4000008260003178',
  '4000582600000094', '4000582600000045', '4000582600000102', '4000582600000110', '4000000000001208', '4000000000003725',
  '4001007020000002', '4000008260000075', '4001000360000005', '4000002760000008',
  '4111111111111111', '4012888888881881', '4222222222222', '378734493671000', '38520000023237', '30569309025904',
]);

const CARD_SHAPES: readonly (readonly number[])[] = [
  [4, 4, 4, 4, 3], [4, 4, 4, 4, 2], [4, 4, 4, 4, 1], [4, 4, 4, 4], [4, 4, 4, 3], [4, 4, 4, 2], [4, 4, 4, 1], [4, 6, 5], [4, 6, 4],
  [19], [18], [17], [16], [15], [14], [13],
];

function cardOk(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  const first = d.charCodeAt(0) - 48;
  return first >= 2 && first <= 6 && luhnValid(d) && !TEST_CARD_NUMBERS.has(d);
}

function cardNumbers(s: string, out?: Span[]): number {
  return eachRun(s, (r) => {
    if (r.sep === null) {
      const d = r.groups[0] ?? '';
      if (!endsClean(s, r.end) || !cardOk(d)) return 0;
      out?.push([r.starts[0] ?? 0, r.end]);
      return 1;
    }
    return countShapes(s, r, CARD_SHAPES, cardOk, out);
  });
}

// ---- iban -----------------------------------------------------------------------------------------------------------

/** IBAN length by country (Wikipedia, "IBAN formats by country", read 25 Nov 2026). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AL: 28, AD: 24, AT: 20, AZ: 28, BH: 22, BY: 28, BE: 16, BA: 20, BR: 29, BG: 22, BI: 27, CR: 22, HR: 21, CY: 28, CZ: 24,
  DK: 18, DJ: 27, DO: 28, TL: 23, EG: 29, SV: 28, EE: 20, FK: 18, FO: 18, FI: 18, FR: 27, GE: 22, DE: 22, GI: 23, GR: 27,
  GL: 18, GT: 28, HN: 28, HU: 28, IS: 26, IQ: 23, IE: 22, IL: 23, IT: 27, JO: 30, KZ: 20, XK: 20, KW: 30, LV: 21, LB: 28,
  LY: 25, LI: 21, LT: 20, LU: 20, MT: 31, MR: 27, MU: 30, MC: 27, MD: 24, MN: 20, ME: 22, NL: 18, NI: 28, MK: 19, NO: 15,
  OM: 23, PK: 24, PS: 29, PL: 28, PT: 25, QA: 29, RO: 24, RU: 33, LC: 32, SM: 27, ST: 25, SA: 24, RS: 22, SC: 31, SK: 24,
  SI: 19, SO: 23, ES: 24, SD: 18, SE: 24, CH: 21, TN: 24, TR: 26, UA: 29, AE: 23, GB: 22, VA: 22, VG: 24, YE: 30,
});

/** ISO 13616 mod-97: move the first four characters to the end, letters to 10..35, the number mod 97 must be 1. */
export function ibanValid(compact: string): boolean {
  const len = IBAN_LENGTHS[compact.slice(0, 2)];
  if (len === undefined || compact.length !== len || !isDigit(compact.charCodeAt(2)) || !isDigit(compact.charCodeAt(3))) return false;
  const r = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < r.length; i++) {
    const c = r.charCodeAt(i);
    if (isDigit(c)) rem = (rem * 10 + (c - 48)) % 97;
    else if (isUpper(c)) rem = (rem * 100 + (c - 55)) % 97;
    else if (c >= 97 && c <= 122) rem = (rem * 100 + (c - 87)) % 97;
    else return false;
  }
  return rem === 1;
}

function ibans(s: string, out?: Span[]): number {
  const n = s.length;
  let hits = 0;
  let i = 0;
  while (i + 4 <= n) {
    const c0 = s.charCodeAt(i);
    if (!isUpper(c0) || (i > 0 && isAlnum(s.charCodeAt(i - 1)))) {
      i++;
      continue;
    }
    const len = IBAN_LENGTHS[s.slice(i, i + 2)];
    if (len === undefined || !isDigit(s.charCodeAt(i + 2)) || !isDigit(s.charCodeAt(i + 3))) {
      i++;
      continue;
    }
    let j = i;
    let got = '';
    while (j < n && got.length < len) {
      const c = s.charCodeAt(j);
      if (isAlnum(c)) {
        got += s[j];
        j++;
      } else if (c === 32 && got.length % 4 === 0 && got.length > 0 && j + 1 < n && isAlnum(s.charCodeAt(j + 1))) j++;
      else break;
    }
    if (got.length === len && (j >= n || !isAlnum(s.charCodeAt(j))) && ibanValid(got)) {
      out?.push([i, j]);
      hits++;
      if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
      i = j;
    } else i++;
  }
  return hits;
}

// ---- us-ssn ---------------------------------------------------------------------------------------------------------

/** SSA: area 000, 666 and 900-999, group 00 and serial 0000 are never assigned. */
export function ssnValid(d: string): boolean {
  if (d.length !== 9) return false;
  const area = Number(d.slice(0, 3));
  return area !== 0 && area !== 666 && area < 900 && d.slice(3, 5) !== '00' && d.slice(5) !== '0000';
}

const SSN_LABELS = ['ssn', 'social security', 'social_security', 'socialsecurity', 'social-security'];

/**
 * A whole run that has exactly the group lengths `shape` (with a separator), or one bare group of the joined length
 * with a label before it, ending clean and passing `ok`. A shape inside a longer run (a phone or serial number) does not
 * count.
 */
function wholeRun(s: string, r: Run, shape: readonly number[], labels: readonly string[], ok: (d: string) => boolean, out?: Span[]): number {
  if (!endsClean(s, r.end)) return 0;
  const d = r.groups.join('');
  const fits = r.sep === null ? d.length === shape.reduce((a, b) => a + b, 0) && labelBefore(s, r.starts[0] ?? 0, labels) : r.groups.length === shape.length && r.groups.every((g, k) => g.length === shape[k]);
  if (!fits || !ok(d)) return 0;
  out?.push([r.starts[0] ?? 0, r.end]);
  return 1;
}

function ssns(s: string, out?: Span[]): number {
  return eachRun(s, (r) => wholeRun(s, r, [3, 2, 4], SSN_LABELS, ssnValid, out));
}

// ---- nhs-number -----------------------------------------------------------------------------------------------------

/** NHS Data Dictionary: weights 10..2 over the first nine digits, check = 11 - (sum mod 11); 11 means 0, 10 is invalid. */
export function nhsValid(d: string): boolean {
  if (d.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (d.charCodeAt(i) - 48) * (10 - i);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === d.charCodeAt(9) - 48;
}

const NHS_LABELS = ['nhs'];

function nhsNumbers(s: string, out?: Span[]): number {
  return eachRun(s, (r) => wholeRun(s, r, [3, 3, 4], NHS_LABELS, nhsValid, out));
}

// ---- email ----------------------------------------------------------------------------------------------------------

function isLocalChar(c: number): boolean {
  return isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
}

function isDomainChar(c: number): boolean {
  return isAlnum(c) || c === 45 || c === 46;
}

/** RFC 2606 and RFC 6761: names reserved for documentation and testing. */
export function reservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  for (const tld of ['.example', '.test', '.invalid', '.localhost']) if (d.endsWith(tld)) return true;
  for (const sld of ['example.com', 'example.net', 'example.org']) if (d === sld || d.endsWith(`.${sld}`)) return true;
  return false;
}

function emails(s: string, out?: Span[]): number {
  const n = s.length;
  let hits = 0;
  let at = s.indexOf('@');
  while (at !== -1) {
    let a = at;
    while (a > 0 && at - a < 65 && isLocalChar(s.charCodeAt(a - 1))) a--;
    let b = at + 1;
    while (b < n && b - at <= 254 && isDomainChar(s.charCodeAt(b))) b++;
    let domain = s.slice(at + 1, b);
    while (domain.endsWith('.') || domain.endsWith('-')) domain = domain.slice(0, -1);
    const local = s.slice(a, at);
    const after = at + 1 + domain.length;
    const labels = domain.split('.');
    const tld = labels[labels.length - 1] ?? '';
    const ok =
      local.length >= 1 &&
      local.length <= 64 &&
      !(a > 0 && isLocalChar(s.charCodeAt(a - 1))) &&
      !local.startsWith('.') &&
      !local.endsWith('.') &&
      labels.length >= 2 &&
      labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-')) &&
      tld.length >= 2 &&
      [...tld].every((ch) => isLetter(ch.charCodeAt(0))) &&
      !(after < n && s.charCodeAt(after) === 58 && after + 1 < n && !/\s/.test(s[after + 1] ?? ' ')) &&
      !reservedDomain(domain);
    if (ok) {
      out?.push([a, after]);
      hits++;
      if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
    }
    at = s.indexOf('@', at + 1);
  }
  return hits;
}

// ---- phone-e164 -----------------------------------------------------------------------------------------------------

const UK_DRAMA: readonly string[] = [
  '2079460', '7700900', '1632960', '1134960', '1144960', '1154960', '1164960', '1174960', '1184960', '1214960', '1314960',
  '1414960', '1514960', '1614960', '1914980', '2920180',
];

/** Fictional ranges: North American 555-0100 to 555-0199, and the UK drama ranges (10-digit national numbers). */
export function fictionalPhone(d: string): boolean {
  if (d.length === 11 && d.startsWith('1') && d.slice(4, 7) === '555' && d.slice(7, 9) === '01') return true;
  if (d.length === 12 && d.startsWith('44')) {
    const rest = d.slice(2);
    return UK_DRAMA.some((p) => rest.startsWith(p));
  }
  return false;
}

function phones(s: string, out?: Span[]): number {
  const n = s.length;
  let hits = 0;
  let i = s.indexOf('+');
  while (i !== -1) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
    if (i + 1 < n && isDigit(s.charCodeAt(i + 1)) && s.charCodeAt(i + 1) !== 48 && !(prev !== -1 && (isWord(prev) || prev === 43))) {
      let j = i + 1;
      let d = '';
      while (j < n && d.length <= 15) {
        const c = s.charCodeAt(j);
        if (isDigit(c)) {
          d += s[j];
          j++;
        } else if ((c === 32 || c === 45 || c === 46) && j + 1 < n && isDigit(s.charCodeAt(j + 1)) && isDigit(s.charCodeAt(j - 1))) j++;
        else break;
      }
      if (d.length >= 8 && d.length <= 15 && endsClean(s, j) && !fictionalPhone(d)) {
        out?.push([i, j]);
        hits++;
        if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
      }
      i = s.indexOf('+', Math.max(j, i + 1));
    } else i = s.indexOf('+', i + 1);
  }
  return hits;
}

// ---- hl7-msh --------------------------------------------------------------------------------------------------------

function isEncodingChar(c: number): boolean {
  return c > 32 && c < 127 && !isAlnum(c);
}

function hl7Headers(s: string, out?: Span[]): number {
  const n = s.length;
  let hits = 0;
  let i = s.indexOf('MSH');
  while (i !== -1) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
    const lineStart = prev === -1 || prev === 10 || prev === 13 || prev === 32 || prev === 9 || prev === 34 || prev === 39 || prev === 96;
    if (lineStart && i + 9 <= n) {
      const sep = s.charCodeAt(i + 3);
      if (isEncodingChar(sep)) {
        const enc: number[] = [];
        let k = i + 4;
        while (k < n && enc.length < 5 && s.charCodeAt(k) !== sep && isEncodingChar(s.charCodeAt(k))) enc.push(s.charCodeAt(k++));
        if ((enc.length === 4 || enc.length === 5) && k < n && s.charCodeAt(k) === sep && new Set(enc).size === enc.length) {
          out?.push([i, k + 1]);
          hits++;
          if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
        }
      }
    }
    i = s.indexOf('MSH', i + 3);
  }
  return hits;
}

// ---- fhir-patient ---------------------------------------------------------------------------------------------------

function skipSpace(s: string, i: number, max: number): number {
  let j = i;
  while (j < s.length && j - i < max && /\s/.test(s[j] ?? '')) j++;
  return j;
}

function fhirPatients(s: string, out?: Span[]): number {
  let hits = 0;
  const key = '"resourceType"';
  let i = s.indexOf(key);
  while (i !== -1) {
    let j = skipSpace(s, i + key.length, 64);
    if (s[j] === ':') {
      j = skipSpace(s, j + 1, 64);
      if (s.startsWith('"Patient"', j)) {
        out?.push([i, j + 9]);
        hits++;
        if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
      }
    }
    i = s.indexOf(key, i + key.length);
  }
  const tag = '<Patient';
  i = s.indexOf(tag);
  while (i !== -1) {
    const next = s[i + tag.length] ?? '';
    if (/[\s>]/.test(next)) {
      const win = s.slice(i, i + 512);
      const close = win.indexOf('>');
      const head = close === -1 ? win : win.slice(0, close);
      if (/xmlns\s{0,8}=\s{0,8}["']http:\/\/hl7\.org\/fhir["']/.test(head)) {
        out?.push([i, i + head.length]);
        hits++;
        if (hits >= MAX_DETECTOR_HITS) return MAX_DETECTOR_HITS;
      }
    }
    i = s.indexOf(tag, i + tag.length);
  }
  return hits;
}

const RUN: Readonly<Record<DetectorName, (s: string, out?: Span[]) => number>> = Object.freeze({
  'secret-token': secretTokens,
  'card-number': cardNumbers,
  iban: ibans,
  'us-ssn': ssns,
  'nhs-number': nhsNumbers,
  email: emails,
  'phone-e164': phones,
  'hl7-msh': hl7Headers,
  'fhir-patient': fhirPatients,
});

/** How many times the detector finds its pattern in `text`, at most MAX_DETECTOR_HITS. Linear in the text's length. */
export function detectCount(name: DetectorName, text: string): number {
  return Math.min(MAX_DETECTOR_HITS, RUN[name](text));
}

/** Where the detector's hits are in `text` (at most MAX_DETECTOR_HITS), for masking. */
export function detectSpans(name: DetectorName, text: string): Span[] {
  const out: Span[] = [];
  RUN[name](text, out);
  return out.slice(0, MAX_DETECTOR_HITS);
}

/** Every detector the rules name, each once, in DETECTOR_NAMES order. Empty for the defaults. */
export function namedDetectors(rules: readonly Rule[]): DetectorName[] {
  const named = new Set<string>();
  for (const r of rules) {
    const d = r.match.detector;
    if (d === undefined) continue;
    for (const x of typeof d === 'string' ? [d] : d) named.add(x);
  }
  return DETECTOR_NAMES.filter((n) => named.has(n));
}

/**
 * The text with every hit of the named detectors replaced by `[<detector>]` (0.16.0). Used for what openmorals itself
 * keeps or sends about an action (the audit line, the session history, the reviewer's text) when the bylaws name a
 * detector, so a value a rule looks for is not copied into openmorals' own records. Unchanged when `names` is empty.
 */
export function maskDetected(text: string, names: readonly DetectorName[]): string {
  if (names.length === 0 || text === '') return text;
  const spans: (readonly [number, number, DetectorName])[] = [];
  for (const n of names) for (const [a, b] of detectSpans(n, text)) spans.push([a, b, n]);
  if (spans.length === 0) return text;
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = '';
  let at = 0;
  for (const [a, b, n] of spans) {
    if (a < at) continue;
    out += `${text.slice(at, a)}[${n}]`;
    at = b;
  }
  return out + text.slice(at);
}
