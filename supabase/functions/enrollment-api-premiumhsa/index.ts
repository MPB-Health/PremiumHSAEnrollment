import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import CryptoJS from "npm:crypto-js@4.2.0";
import {
  buildIdempotentEnrollmentResponse,
  computePayloadHash,
  extractMemberIdFromExternalResponse,
  isValidSubmissionId,
  loadSubmission,
  markSubmissionEnrolled,
  upsertSubmissionStarted,
} from "../_shared/enrollmentSubmissions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, Cache-Control, X-Submission-Id",
};

/** Monthly tobacco fee in API payload (matches `TOBACCO_USE_MONTHLY_FEE` in `src/utils/pricingLogic.ts`). */
const TOBACCO_USE_MONTHLY_FEE = "75.00";

const DEFAULT_PROMO_PDID = (() => {
  const v = Deno.env.get("DEFAULT_PROMO_PDID");
  if (v == null || v.trim() === "") return 44036;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 44036;
})();

function escapePromoCodeForILike(trimmed: string): string {
  return trimmed
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function normalizePromoCodeInput(raw: string): string {
  let s = raw.trim();
  while (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function normalizePromoProductToken(value: string): string {
  return value.trim().toLowerCase();
}

function effectivePdidFromRequest(pdid: unknown): number {
  if (typeof pdid === "number" && pdid > 0) return pdid;
  if (typeof pdid === "string") {
    const n = parseInt(pdid.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PROMO_PDID;
}

function promoProductMatchesEnrollment(
  product: string | null | undefined,
  effectivePdidValue: number,
): boolean {
  const p = product == null ? "" : String(product);
  const n = normalizePromoProductToken(p);
  if (n === "" || n === "*" || n === "all" || n === "any") return true;
  return normalizePromoProductToken(String(effectivePdidValue)) === n;
}

interface EncryptedBlock {
  encryptedData: string;
  encryptedKey: string;
  iv: string;
}

interface DecryptedSensitiveFields {
  ssn: string;
  payment: {
    ccType: string;
    ccNumber: string;
    ccExpMonth: string;
    ccExpYear: string;
    achrouting: string;
    achaccount: string;
    achbank: string;
    paymentType: string;
    paymentMethod: string;
  };
  questionnaireAnswers: Record<string, unknown>;
  dependentSsns: string[];
  dependentDobs: string[];
  dependentEmails: string[];
  dependentPhones?: string[];
  benefitId: string;
  pdid: unknown;
  phone: string;
  email: string;
  agent: string;
  dob: string;
  city: string;
  appliedPromo: unknown;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importRsaPrivateKey(): Promise<CryptoKey> {
  const privateKeyBase64 = Deno.env.get("RSA_PRIVATE_KEY");
  if (!privateKeyBase64) {
    throw new Error("RSA_PRIVATE_KEY secret not configured");
  }
  const keyBuffer = base64ToArrayBuffer(privateKeyBase64);
  return crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["unwrapKey"]
  );
}

async function decryptSensitivePayload(encrypted: EncryptedBlock): Promise<DecryptedSensitiveFields> {
  const rsaPrivateKey = await importRsaPrivateKey();

  const aesKey = await crypto.subtle.unwrapKey(
    "raw",
    base64ToArrayBuffer(encrypted.encryptedKey),
    rsaPrivateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToArrayBuffer(encrypted.iv) },
    aesKey,
    base64ToArrayBuffer(encrypted.encryptedData)
  );

  const decryptedText = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(decryptedText);
}

function mergeDecryptedFields(
  requestData: Record<string, unknown>,
  decrypted: DecryptedSensitiveFields
): void {
  requestData.ssn = decrypted.ssn;

  if (decrypted.payment) {
    const existingPayment = (requestData.payment as Record<string, unknown>) || {};
    requestData.payment = { ...existingPayment, ...decrypted.payment };
  }

  if (decrypted.questionnaireAnswers) {
    requestData.questionnaireAnswers = decrypted.questionnaireAnswers;
  }

  if (decrypted.dependentSsns && Array.isArray(requestData.dependents)) {
    const dependents = requestData.dependents as Array<Record<string, unknown>>;
    decrypted.dependentSsns.forEach((ssn, index) => {
      if (index < dependents.length) {
        dependents[index].ssn = ssn;
      }
    });
  }

  if (decrypted.dependentDobs && Array.isArray(requestData.dependents)) {
    const dependents = requestData.dependents as Array<Record<string, unknown>>;
    decrypted.dependentDobs.forEach((dob, index) => {
      if (index < dependents.length) {
        dependents[index].dob = dob ? normalizeDobFormat(dob) : '';
      }
    });
  }

  if (decrypted.dependentEmails && Array.isArray(requestData.dependents)) {
    const dependents = requestData.dependents as Array<Record<string, unknown>>;
    decrypted.dependentEmails.forEach((email, index) => {
      if (index < dependents.length && email !== undefined) {
        dependents[index].email = email;
      }
    });
  }

  if (decrypted.dependentPhones && Array.isArray(requestData.dependents)) {
    const dependents = requestData.dependents as Array<Record<string, unknown>>;
    decrypted.dependentPhones.forEach((phone, index) => {
      if (index < dependents.length && phone !== undefined) {
        dependents[index].phone = phone;
      }
    });
  }

  if (decrypted.benefitId !== undefined) requestData.benefitId = decrypted.benefitId;
  if (decrypted.pdid !== undefined) requestData.pdid = decrypted.pdid;
  if (decrypted.phone !== undefined) requestData.phone = decrypted.phone;
  if (decrypted.email !== undefined) requestData.email = decrypted.email;
  if (decrypted.agent !== undefined) requestData.agent = decrypted.agent;
  if (decrypted.dob !== undefined) requestData.dob = normalizeDobFormat(decrypted.dob);
  if (decrypted.city !== undefined) requestData.city = decrypted.city;
  if (decrypted.appliedPromo !== undefined) requestData.appliedPromo = decrypted.appliedPromo;

  delete requestData._encrypted;
}

function normalizeDobFormat(dob: string): string {
  if (!dob || typeof dob !== 'string') return dob;
  const trimmed = dob.trim();
  const mmddyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const [, m, d, y] = mmddyyyy;
    return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${y}`;
  }
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${m}/${d}/${y}`;
  }
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  }
  return trimmed;
}

/** Mirrors `calculateAgeFromDOB` in src/utils/pricingLogic.ts (MM/DD/YYYY). */
function calculateAgeFromDobMmDdYyyy(dob: string): number | null {
  const trimmed = (dob ?? "").trim();
  const mmddyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!mmddyyyy) return null;
  const month = parseInt(mmddyyyy[1], 10);
  const day = parseInt(mmddyyyy[2], 10);
  const year = parseInt(mmddyyyy[3], 10);
  if (!month || !day || !year) return null;
  const birthDate = new Date(year, month - 1, day);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

function decryptPassword(encryptedPassword: string): string {
  try {
    const secretKey = Deno.env.get("VITE_ENCRYPTION_SECRET_KEY");
    if (!secretKey) {
      throw new Error("Encryption secret key not configured");
    }
    const decrypted = CryptoJS.AES.decrypt(encryptedPassword, secretKey);
    const originalPassword = decrypted.toString(CryptoJS.enc.Utf8);
    if (!originalPassword) {
      throw new Error("Decryption resulted in empty string");
    }
    return originalPassword;
  } catch (error) {
    throw new Error("Failed to decrypt password");
  }
}

interface Dependent {
  firstName: string;
  lastName: string;
  dob: string;
  smoker: string;
  relationship: 'Spouse' | 'Child';
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  phone?: string;
  ssn?: string;
  gender?: string;
  email?: string;
}

interface PaymentInfo {
  ccType: string;
  ccNumber: string;
  ccExpMonth: string;
  ccExpYear: string;
  paymentType: string;
  achrouting?: string;
  achaccount?: string;
  achbank?: string;
}

interface EnrollmentRequest {
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  smoker: string;
  address1: string;
  city: string;
  state: string;
  zipcode: string;
  phone: string;
  ssn: string;
  gender: string;
  agent: string;
  uniqueId: string;
  effectiveDate: string;
  benefitId: string;
  selectedPrice: number;
  dependents: Dependent[];
  payment: PaymentInfo;
  pdid?: number;
  promoCode?: string;
  /** Restored from encrypted payload after merge; used when plain `promoCode` is empty. */
  appliedPromo?: unknown;
  zohoContactId?: string;
  referral?: string;
}

/** Plain `promoCode` may be missing on encrypted envelopes; `appliedPromo` is merged from `_encrypted`. */
function resolvedPromoCodeForLookup(requestData: EnrollmentRequest): string {
  const fromField = typeof requestData.promoCode === "string" ? requestData.promoCode.trim() : "";
  if (fromField !== "") return fromField;
  const ap = requestData.appliedPromo;
  if (ap && typeof ap === "object") {
    const code = (ap as { code?: unknown }).code;
    if (typeof code === "string" && code.trim() !== "") return code.trim();
  }
  return "";
}

/** Combines optional referral text with Zoho contact id for SOURCEDETAIL. */
function buildSourceDetail(referral: string | undefined, zohoContactId: string | undefined): string {
  const r = (referral ?? "").trim();
  const zid = (zohoContactId ?? "").trim();
  const zohoPart = zid ? `Zoho: ${zid}` : "";
  if (r && zohoPart) return `${r} | ${zohoPart}`;
  if (r) return r;
  return zohoPart;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(req.url);
    const agentIdParam = url.searchParams.get('id');
    const agentNumber = agentIdParam ? parseInt(agentIdParam) : 768413;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ success: false, status: 500, error: "Database configuration error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // GET: poll the status of an existing submission (used by the frontend to
    // resume PDF/gateway phases after a duplicate-submit guard kicks in).
    if (req.method === "GET") {
      const statusSubmissionId = url.searchParams.get("submissionId");
      if (!isValidSubmissionId(statusSubmissionId)) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Valid submissionId query param is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const row = await loadSubmission(supabase, statusSubmissionId!);
      if (!row) {
        return new Response(
          JSON.stringify({ success: false, status: 404, error: "Submission not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          status: row.status,
          memberId: row.member_id,
          pdfUrl: row.pdf_url,
          gatewayAttempts: row.gateway_attempts,
          lastError: row.last_error,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, status: 405, error: "Method not allowed" }),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Idempotency key from the client. When present we de-duplicate member
    // creation; when absent we fall back to the legacy direct-submit path so a
    // not-yet-updated frontend keeps working (tolerant rollout).
    const submissionIdHeader = req.headers.get("X-Submission-Id")?.trim() ?? "";
    const submissionId = isValidSubmissionId(submissionIdHeader) ? submissionIdHeader : null;

    const { data: advisorData, error: advisorError } = await supabase
      .from('advisor')
      .select('username, password')
      .eq('sales_id', agentNumber)
      .maybeSingle();

    if (advisorError) {
      return new Response(
        JSON.stringify({
          success: false,
          status: 500,
          error: "Failed to retrieve advisor credentials",
          details: advisorError.message
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!advisorData) {
      return new Response(
        JSON.stringify({
          success: false,
          status: 404,
          error: `Advisor not found for agent number: ${agentNumber}`
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!advisorData.username || !advisorData.password) {
      return new Response(
        JSON.stringify({
          success: false,
          status: 500,
          error: "API credentials not configured for this advisor"
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const username = advisorData.username;
    let password: string;

    try {
      password = decryptPassword(advisorData.password);
    } catch (decryptError) {
      return new Response(
        JSON.stringify({
          success: false,
          status: 500,
          error: "Failed to decrypt advisor credentials"
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const rawRequestData = await req.json();
    let decryptedSensitive: DecryptedSensitiveFields | null = null;

    if (rawRequestData._encrypted) {
      try {
        decryptedSensitive = await decryptSensitivePayload(rawRequestData._encrypted);
        mergeDecryptedFields(rawRequestData, decryptedSensitive);
      } catch (decryptError) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Failed to decrypt enrollment payload" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const requestData: EnrollmentRequest = rawRequestData;

    const requiredFields: { value: string | undefined; label: string }[] = [
      { value: requestData.firstName, label: 'First name' },
      { value: requestData.lastName, label: 'Last name' },
      { value: requestData.dob, label: 'Date of birth' },
      { value: requestData.email, label: 'Email' },
      { value: requestData.ssn, label: 'Social Security number' },
      { value: requestData.phone, label: 'Phone number' },
      { value: requestData.address1, label: 'Address' },
      { value: requestData.city, label: 'City' },
      { value: requestData.state, label: 'State' },
      { value: requestData.zipcode, label: 'Zipcode' },
      { value: requestData.gender, label: 'Gender' },
      { value: requestData.effectiveDate, label: 'Effective date' },
    ];

    for (const { value, label } of requiredFields) {
      if (!value || !value.trim()) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: `${label} is required` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const ssnDigits = requestData.ssn.replace(/\D/g, '');
    if (ssnDigits.length !== 9) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "SSN must be exactly 9 digits" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const phoneDigits = requestData.phone.replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Phone number must be exactly 10 digits" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(requestData.email)) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Invalid email format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!/^\d{5}$/.test(requestData.zipcode)) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Zipcode must be exactly 5 digits" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!requestData.benefitId) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Benefit ID is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const validBenefitIds = [
      '3277', '3278', '3279', '3280', '3281',
      '3282', '3283', '3284', '3285', '3286',
      '3287', '3288', '3289', '3290', '3291',
      '3292', '3293', '3294', '3295', '3296',
    ];

    if (!validBenefitIds.includes(requestData.benefitId)) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: `Invalid benefit ID: ${requestData.benefitId}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (requestData.dependents?.length) {
      for (let i = 0; i < requestData.dependents.length; i++) {
        const dep = requestData.dependents[i];
        const dobNorm = normalizeDobFormat((dep.dob as string) || "");
        const age = calculateAgeFromDobMmDdYyyy(dobNorm);
        if (age === null) continue;
        if (dep.relationship === "Spouse" && age < 18) {
          return new Response(
            JSON.stringify({
              success: false,
              status: 400,
              error: "Must be 18 years or older to enroll",
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (dep.relationship === "Child" && age >= 26) {
          return new Response(
            JSON.stringify({
              success: false,
              status: 400,
              error: "Child dependents must be under 26 years of age",
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    if (!requestData.selectedPrice || requestData.selectedPrice <= 0) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Valid selected price is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!requestData.payment) {
      return new Response(
        JSON.stringify({ success: false, status: 400, error: "Payment information is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const isACH = requestData.payment.paymentType === 'ACH';
    const isListBill = requestData.payment.paymentType === 'LB';
    let sanitizedCardNumber = '';

    if (isListBill) {
      // List Bill requires no card or bank details.
    } else if (isACH) {
      if (!requestData.payment.achrouting || !requestData.payment.achaccount || !requestData.payment.achbank) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Incomplete ACH payment information" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const sanitizedRouting = requestData.payment.achrouting.replace(/\D/g, '');
      if (sanitizedRouting.length !== 9) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Routing number must be exactly 9 digits" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const sanitizedAccount = requestData.payment.achaccount.replace(/\D/g, '');
      if (sanitizedAccount.length === 0) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Invalid account number" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (!requestData.payment.achbank.trim()) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Bank name is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    } else {
      if (!requestData.payment.ccType || !requestData.payment.ccNumber ||
          !requestData.payment.ccExpMonth || !requestData.payment.ccExpYear) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Incomplete credit card information" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      sanitizedCardNumber = requestData.payment.ccNumber.replace(/\s/g, '');
      if (sanitizedCardNumber.length < 15 || sanitizedCardNumber.length > 16) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Invalid card number length" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const currentYear = new Date().getFullYear() % 100;
      const currentMonth = new Date().getMonth() + 1;
      const expYear = parseInt(requestData.payment.ccExpYear);
      const expMonth = parseInt(requestData.payment.ccExpMonth);
      if (expYear < currentYear || (expYear === currentYear && expMonth < currentMonth)) {
        return new Response(
          JSON.stringify({ success: false, status: 400, error: "Card has expired" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    const convertGender = (gender: string): string => {
      const normalized = gender.toLowerCase();
      if (normalized === 'male') return 'M';
      if (normalized === 'female') return 'F';
      return gender.toUpperCase();
    };

    const convertSmoker = (smoker: string): string => {
      const normalized = smoker.toLowerCase();
      if (normalized === 'yes') return 'Y';
      if (normalized === 'no') return 'N';
      return smoker.toUpperCase();
    };

    const extractPhoneDigits = (phone: string): string => {
      return phone.replace(/\D/g, '').slice(0, 10);
    };

    const extractSSNDigits = (ssn: string): string => {
      return ssn.replace(/\D/g, '').slice(0, 9);
    };

    const formatDateToMMDDYYYY = (dateString: string): string => {
      const date = new Date(dateString);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const year = date.getFullYear();
      return `${month}/${day}/${year}`;
    };

    const productFeeAmount = requestData.selectedPrice.toFixed(2);

    let enrollmentFeeAmount = "100.00";

    const promoCodeForLookup = resolvedPromoCodeForLookup(requestData);

    if (promoCodeForLookup !== "") {
      const normalizedPromo = normalizePromoCodeInput(promoCodeForLookup);
      if (normalizedPromo !== "") {
        const pattern = escapePromoCodeForILike(normalizedPromo);
        const effPdid = effectivePdidFromRequest(requestData.pdid);

        try {
          const { data: promoRows, error: promoError } = await supabase
            .from('promocodes')
            .select('code, product, discount_amount')
            .ilike('code', pattern)
            .eq('active', true);

          const promoData = (promoRows ?? []).find((r) =>
            promoProductMatchesEnrollment(r.product, effPdid),
          );

          if (!promoError && promoData) {
            const discountAmount = parseFloat(String(promoData.discount_amount));

            if (!isNaN(discountAmount) && discountAmount >= 0) {
              const calculatedFee = Math.max(0, 100.0 - discountAmount);
              enrollmentFeeAmount = calculatedFee.toFixed(2);
            }
          }
        } catch {
          // Promo code validation error handled silently
        }
      }
    }

    const isPrimarySmoker = requestData.smoker.toLowerCase() === 'yes';
    const hasSmokerDependent = requestData.dependents.some(dep => dep.smoker.toLowerCase() === 'yes');
    const tobaccoFeeAmount = (isPrimarySmoker || hasSmokerDependent) ? TOBACCO_USE_MONTHLY_FEE : "0.00";

    const memberData = {
      CORPID: 1402,
      AGENT: agentNumber,
      SOURCEDETAIL: buildSourceDetail(requestData.referral, requestData.zohoContactId),
      LEAD:"N",
      UNIQUEID: requestData.uniqueId,
      USEINTERNALIDASMEMBERID: "N",
      FIRSTNAME: requestData.firstName,
      LASTNAME: requestData.lastName,
      DOB: normalizeDobFormat(requestData.dob as string),
      EMAIL: requestData.email,
      ADDRESS1: requestData.address1,
      CITY: requestData.city,
      STATE: requestData.state,
      ZIPCODE: requestData.zipcode,
      PHONE1: extractPhoneDigits(requestData.phone),
      GENDER: convertGender(requestData.gender),
      TOBACCO: convertSmoker(requestData.smoker),
      SSN: extractSSNDigits(requestData.ssn || ''),
      PAYMENTPROCESS: "Y",
      DEPENDENTS: requestData.dependents.map(dep => ({
        FIRSTNAME: dep.firstName,
        LASTNAME: dep.lastName,
        ADDRESS: dep.address || requestData.address1,
        CITY: dep.city || requestData.city,
        STATE: dep.state || requestData.state,
        ZIPCODE: parseInt(dep.zipcode || requestData.zipcode),
        PHONE1: extractPhoneDigits(dep.phone || ''),
        DOB: normalizeDobFormat((dep.dob as string) || ''),
        GENDER: convertGender(dep.gender || 'M'),
        SSN: extractSSNDigits(dep.ssn || ''),
        EMAIL: dep.email || '',
        RELATIONSHIP: dep.relationship,
        TOBACCO: convertSmoker(dep.smoker),
      })),
      PRODUCTS: [
        {
            PDID: 43960,
            BENEFITID: 449,
            periodid: 1,
            dtEffective: formatDateToMMDDYYYY(requestData.effectiveDate),
            bPaid: "N"
        },
        {
            PDID: 44036,
            BENEFITID: parseInt(requestData.benefitId),
            periodid: 1,
            dtEffective: formatDateToMMDDYYYY(requestData.effectiveDate),
            bPaid: "N",
          FEES:[
          	{
            	TYPE:"Annual Membership",
            	AMOUNT:"25.00",
            	BENEFITID: 9493,
            	PERIODID: 5
          	},
        		{
          		TYPE:"Enrollment",
          		AMOUNT: enrollmentFeeAmount,
          		BENEFITID: 6335,
          		PERIODID: 7
        		},
        		{
          		TYPE:"Product",
          		AMOUNT: productFeeAmount,
          		BENEFITID: parseInt(requestData.benefitId),
          		PERIODID: 1
        		},
            {
          		TYPE:"Tobacco Use",
          		AMOUNT: tobaccoFeeAmount,
          		BENEFITID: 8037,
          		PERIODID: 1
        		} 
          ]
        }
      ],
      PAYMENT: isACH ? {
        PAYMENTTYPE: 'ACH',
        ACHROUTING: requestData.payment.achrouting,
        ACHACCOUNT: requestData.payment.achaccount,
        ACHBANK: requestData.payment.achbank,
        FIRSTNAME: requestData.firstName,
        LASTNAME: requestData.lastName,
      } : isListBill ? {
        PAYMENTTYPE: 'LB',
        CCEXPYEAR: '',
        CCTYPE: '',
        CCNUMBER: '',
        CCEXPMONTH: '',
      } : {
        FIRSTNAME: requestData.firstName,
        LASTNAME: requestData.lastName,
        CCEXPYEAR: requestData.payment.ccExpYear,
        PAYMENTTYPE: requestData.payment.paymentType,
        CCTYPE: requestData.payment.ccType,
        CCNUMBER: sanitizedCardNumber,
        CCEXPMONTH: requestData.payment.ccExpMonth,
      },

    };

    const memberJsonString = JSON.stringify(memberData);

    // Idempotency gate: ensure the member is created at most once per submission.
    if (submissionId) {
      const payloadHash = computePayloadHash(
        requestData.email,
        requestData.effectiveDate,
        requestData.benefitId,
        agentNumber,
      );

      const { row: submissionRow, error: submissionError } = await upsertSubmissionStarted(
        supabase,
        {
          submissionId,
          customerEmail: requestData.email,
          agentNumber,
          payloadHash,
        },
      );

      if (submissionError === "in_progress") {
        return new Response(
          JSON.stringify({
            success: false,
            status: 409,
            error: "Enrollment already in progress for this submission",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (submissionRow?.member_id) {
        return new Response(
          JSON.stringify(
            buildIdempotentEnrollmentResponse(
              submissionRow.enrollment_response,
              submissionRow.member_id,
            ),
          ),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const formData = new URLSearchParams();
    formData.append("member", memberJsonString);

    const authString = btoa(`${username}:${password}`);

    const externalApiUrl = `https://api.1administration.com/v1/${agentNumber}/member/0.json`;

    const response = await fetch(externalApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${authString}`,
      },
      body: formData.toString(),
    });

    const responseData = await response.json();

    try {
      const { error: logError } = await supabase.from("PremiumHsa_log").insert({
        date: new Date().toISOString(),
        log: memberJsonString,
        response: JSON.stringify(responseData),
      });
      if (logError) {
        console.error("PremiumHsa_log insert failed:", logError.message);
      }
    } catch (logErr) {
      console.error("PremiumHsa_log insert exception:", logErr);
    }

    // Record the member id so retries replay instead of re-enrolling.
    if (submissionId && response.ok && responseData && typeof responseData === "object") {
      const root = responseData as Record<string, unknown>;
      const tx = root.TRANSACTION as Record<string, unknown> | undefined;
      const txVal = (tx?.SUCCESS ?? root.SUCCESS) as unknown;
      const isSuccess =
        txVal === true ||
        txVal === "true" ||
        (typeof txVal === "string" && txVal.toLowerCase() === "true");

      if (isSuccess) {
        const enrolledMemberId = extractMemberIdFromExternalResponse(responseData);
        if (enrolledMemberId) {
          await markSubmissionEnrolled(supabase, submissionId, enrolledMemberId, responseData);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: response.ok,
        status: response.status,
        data: responseData,
      }),
      {
        status: response.ok ? 200 : response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        status: 500,
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error occurred",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
