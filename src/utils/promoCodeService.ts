import { supabase } from '../lib/supabaseClient';
import { AppliedPromo } from '../hooks/useEnrollmentStorage';

const rawDefault = import.meta.env.VITE_DEFAULT_PROMO_PDID;
const parsedDefault =
  rawDefault != null && String(rawDefault).trim() !== ''
    ? Number(rawDefault)
    : NaN;
export const DEFAULT_PROMO_PDID =
  Number.isFinite(parsedDefault) && parsedDefault > 0 ? parsedDefault : 44036;

export interface PromoCodeValidationResult {
  success: boolean;
  promo?: AppliedPromo;
  error?: string;
}

export function escapePromoCodeForILike(trimmed: string): string {
  return trimmed
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** Trim and remove one outer pair of parentheses, e.g. "(LIVEWELL)" → "LIVEWELL". */
export function normalizePromoCodeInput(raw: string): string {
  let s = raw.trim();
  while (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function normalizeProductToken(value: string): string {
  return value.trim().toLowerCase();
}

export function effectivePdid(pdid: number | null | undefined): number {
  if (typeof pdid === 'number' && pdid > 0) {
    return pdid;
  }
  return DEFAULT_PROMO_PDID;
}

export function promoProductMatchesEnrollment(
  product: string | null | undefined,
  effectivePdidValue: number
): boolean {
  const p = product == null ? '' : String(product);
  const n = normalizeProductToken(p);
  if (n === '' || n === '*' || n === 'all' || n === 'any') {
    return true;
  }
  return normalizeProductToken(String(effectivePdidValue)) === n;
}

export async function validatePromoCode(
  code: string,
  pdid?: number | null
): Promise<PromoCodeValidationResult> {
  if (!code || code.trim() === '') {
    return {
      success: false,
      error: 'Please enter an enrollment code',
    };
  }

  if (!supabase) {
    return {
      success: false,
      error:
        'Enrollment codes are not available: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file.',
    };
  }

  const normalizedInput = normalizePromoCodeInput(code);
  if (normalizedInput === '') {
    return {
      success: false,
      error: 'Please enter an enrollment code',
    };
  }

  const pattern = escapePromoCodeForILike(normalizedInput);
  const eff = effectivePdid(pdid);

  try {
    const { data: rows, error } = await supabase
      .from('promocodes')
      .select('code, product, discount_amount')
      .ilike('code', pattern)
      .eq('active', true);

    if (error) {
      console.error('Error validating promo code:', error);
      return {
        success: false,
        error: 'Error validating enrollment code. Please try again.',
      };
    }

    const row = (rows ?? []).find((r) =>
      promoProductMatchesEnrollment(r.product, eff),
    );

    if (!row) {
      return {
        success: false,
        error: 'Invalid enrollment code',
      };
    }

    return {
      success: true,
      promo: {
        code: row.code,
        product: row.product,
        discountAmount: parseFloat(row.discount_amount),
      },
    };
  } catch (err) {
    console.error('Error validating promo code:', err);
    return {
      success: false,
      error: 'Network error. Please check your connection and try again.',
    };
  }
}

export function applyPromoDiscount(
  initialPayment: number,
  appliedPromo: AppliedPromo | null
): number {
  if (!appliedPromo) {
    return initialPayment;
  }

  const discountedAmount = initialPayment - appliedPromo.discountAmount;
  return Math.max(0, discountedAmount);
}
