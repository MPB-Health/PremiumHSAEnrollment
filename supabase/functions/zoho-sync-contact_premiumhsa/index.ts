import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, Cache-Control",
};

interface EncryptedBlock {
  encryptedData: string;
  encryptedKey: string;
  iv: string;
}

interface DecryptedClientData {
  ssn: string;
  phone: string;
  email: string;
  dob: string;
  dependentSsns: string[];
  dependentPhones: string[];
  dependentEmails: string[];
  dependentDobs: string[];
}

interface DependentPayload {
  firstName: string;
  lastName: string;
  dob: string;
  relationship: "Spouse" | "Child";
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  phone?: string;
  ssn?: string;
  gender?: string;
  email?: string;
  useSameAddress?: boolean;
}

interface ZohoSyncPayload {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  address1: string;
  city: string;
  state: string;
  zipcode: string;
  ssn: string;
  gender: string;
  effectiveDate: string;
  benefitId: string;
  selectedPrice: number;
  dependents: DependentPayload[];
  agentId: string;
  encrypted?: EncryptedBlock;
}

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
}

interface ZohoContact {
  id: string;
  [key: string]: unknown;
}

interface ZohoSearchResponse {
  data?: ZohoContact[];
  info?: { count: number };
}

interface ZohoUpsertResponse {
  data?: Array<{
    code: string;
    details: { id: string };
    message: string;
    status: string;
  }>;
}

/** Fixed Zoho CRM Contact `Product_Type` for this enrollment line (PDID 44036); not tied to IUA benefit id. */
const ZOHO_CONTACT_PRODUCT_TYPE = "Premium HSA (44036)";

const COVERAGE_MAP: Record<string, string> = {
  "3277": "Member Only",
  "3278": "Member Only",
  "3279": "Member Only",
  "3280": "Member Only",
  "3281": "Member Only",
  "3282": "Member + Spouse",
  "3283": "Member + Spouse",
  "3284": "Member + Spouse",
  "3285": "Member + Spouse",
  "3286": "Member + Spouse",
  "3287": "Member + Children",
  "3288": "Member + Children",
  "3289": "Member + Children",
  "3290": "Member + Children",
  "3291": "Member + Children",
  "3292": "Member + Family",
  "3293": "Member + Family",
  "3294": "Member + Family",
  "3295": "Member + Family",
  "3296": "Member + Family",
};

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

async function decryptSensitivePayload(encrypted: EncryptedBlock): Promise<DecryptedClientData> {
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

function normalizePhone(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits.slice(0, 10);
}

function normalizeSsn(ssn: string): string {
  if (!ssn) return "";
  return ssn.replace(/\D/g, "").slice(0, 9);
}

/**
 * Client encrypts sensitive fields and replaces them on the wire with the literal
 * string `[encrypted]` (see `EnrollmentWizard.tsx` -> syncToZoho). Treat that
 * marker as an empty value so it never leaks into Zoho typed fields when an
 * optional dependent field (e.g. minor-child Email) is legitimately blank.
 * Both casings handled defensively in case a sibling repo uses `[ENCRYPTED]`.
 */
function stripEncryptedPlaceholder(value: string | undefined | null): string {
  if (value == null) return "";
  const trimmed = String(value).trim();
  if (trimmed === "[encrypted]" || trimmed === "[ENCRYPTED]") return "";
  return trimmed;
}

/**
 * Resolves a per-dependent encrypted field. Prefers the decrypted array even
 * when the value at that index is empty — that empty value intentionally
 * overwrites the client `[encrypted]` placeholder for optional fields like a
 * minor child's Email/Phone/SSN. Falls back to the client payload only when the
 * decrypted array is absent or shorter than `idx` (e.g. encryption disabled).
 */
function resolveDependentField(
  decryptedArr: string[] | undefined,
  idx: number,
  clientFallback: string | undefined
): string {
  if (Array.isArray(decryptedArr) && idx < decryptedArr.length) {
    return decryptedArr[idx] ?? "";
  }
  return stripEncryptedPlaceholder(clientFallback);
}

function convertDateToZoho(dateStr: string): string {
  if (!dateStr) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  try {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split("T")[0];
    }
  } catch {
    // Fall through
  }
  return dateStr;
}

function buildFullAddress(
  address: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zipcode: string | undefined
): string {
  const parts = [address, city, state, zipcode].filter(Boolean);
  return parts.join(", ");
}

async function getZohoAccessToken(): Promise<string> {
  const clientId = Deno.env.get("ZOHO_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
  const refreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Zoho OAuth credentials not configured");
  }

  const tokenUrl = "https://accounts.zoho.com/oauth/v2/token";
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data: ZohoTokenResponse = await response.json();

  if (data.error || !data.access_token) {
    throw new Error(`Zoho authentication failed: ${data.error || "No access token"}`);
  }

  return data.access_token;
}

async function searchContactByEmail(
  accessToken: string,
  email: string
): Promise<ZohoContact | null> {
  const searchUrl = `https://www.zohoapis.com/crm/v2/Contacts/search?email=${encodeURIComponent(email)}`;

  const response = await fetch(searchUrl, {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  if (response.status === 204) {
    return null;
  }

  const data: ZohoSearchResponse = await response.json();

  if (data.data && data.data.length > 0) {
    return data.data[0];
  }

  return null;
}

async function createOrUpdateContact(
  accessToken: string,
  contactData: Record<string, unknown>,
  existingId?: string
): Promise<{ id: string; action: "create" | "update" }> {
  const method = existingId ? "PUT" : "POST";
  const url = existingId
    ? `https://www.zohoapis.com/crm/v2/Contacts/${existingId}`
    : "https://www.zohoapis.com/crm/v2/Contacts";

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [contactData] }),
  });

  const responseText = await response.text();
  let data: ZohoUpsertResponse;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Invalid Zoho response: ${responseText}`);
  }

  if (data.data && data.data[0]) {
    const result = data.data[0];

    if (result.code === "DUPLICATE_DATA" && result.details?.id) {
      return createOrUpdateContact(accessToken, contactData, result.details.id);
    }

    if (result.status === "success" && result.details?.id) {
      return {
        id: result.details.id,
        action: existingId ? "update" : "create",
      };
    }

    throw new Error(`Zoho operation failed: ${result.message || result.code}`);
  }

  throw new Error(`Unexpected Zoho response: ${responseText}`);
}

function buildZohoContactPayload(
  payload: ZohoSyncPayload,
  decrypted: DecryptedClientData,
  ownerName?: string
): Record<string, unknown> {
  const primaryEmail = decrypted.email || stripEncryptedPlaceholder(payload.email);
  const primaryPhone = normalizePhone(decrypted.phone || stripEncryptedPlaceholder(payload.phone));
  const primaryDob = convertDateToZoho(decrypted.dob || stripEncryptedPlaceholder(payload.dob));
  const primarySsn = normalizeSsn(decrypted.ssn || stripEncryptedPlaceholder(payload.ssn));

  const contact: Record<string, unknown> = {
    First_Name: payload.firstName,
    Last_Name: payload.lastName,
    Email: primaryEmail,
    Phone: primaryPhone,
    Date_of_Birth: primaryDob,
    Mailing_Street: payload.address1,
    Mailing_City: payload.city,
    Mailing_State: payload.state,
    Mailing_Zip: payload.zipcode,
    Social_Security_Number: primarySsn,
    Primary_Member: payload.gender,
    Start_Date: convertDateToZoho(payload.effectiveDate),
    Monthly_Premium: payload.selectedPrice,
    Lead_Source: "Enrollment Platform",
    Account_Name: ownerName,
    Contact_Status: "New Enrollment",
    Carrier: "Zion Health",
    Company_Association: "MPB Health",
    Product_Type: ZOHO_CONTACT_PRODUCT_TYPE,
    Coverage_Option: COVERAGE_MAP[payload.benefitId] || "Unknown",
  };

  if (ownerName) {
    contact.Owner_Name = ownerName;
  }

  const dependents = payload.dependents || [];
  let childIndex = 1;

  dependents.forEach((dep, idx) => {
    const depSsn = resolveDependentField(decrypted.dependentSsns, idx, dep.ssn);
    const depPhone = resolveDependentField(decrypted.dependentPhones, idx, dep.phone);
    const depEmail = resolveDependentField(decrypted.dependentEmails, idx, dep.email);
    const depDob = resolveDependentField(decrypted.dependentDobs, idx, dep.dob);

    const depAddress = dep.useSameAddress
      ? buildFullAddress(payload.address1, payload.city, payload.state, payload.zipcode)
      : buildFullAddress(dep.address, dep.city, dep.state, dep.zipcode);

    // Email/Phone/SSN are optional for child dependents under 18 (and defensively
    // handled the same way for spouses). Zoho rejects empty strings on typed
    // fields (e.g. INVALID_DATA on Email/Date), so omit the key entirely when
    // there's no usable value rather than sending "" or the [encrypted] marker.
    if (dep.relationship === "Spouse") {
      contact.Spouse = `${dep.firstName} ${dep.lastName}`;
      const spouseDob = convertDateToZoho(depDob);
      if (spouseDob) contact.Spouse_DOB = spouseDob;
      const spouseEmail = stripEncryptedPlaceholder(depEmail);
      if (spouseEmail) contact.Spouse_Email = spouseEmail;
      const spousePhone = normalizePhone(depPhone);
      if (spousePhone) contact.Spouse_Phone_Number = spousePhone;
      const spouseSsn = normalizeSsn(depSsn);
      if (spouseSsn) contact.Spouse_Social_Security = spouseSsn;
      if (depAddress) contact.Spouse_Address = depAddress;
    } else if (dep.relationship === "Child") {
      contact[`Child_${childIndex}`] = `${dep.firstName} ${dep.lastName}`;
      const childDob = convertDateToZoho(depDob);
      if (childDob) contact[`Child_${childIndex}_DOB`] = childDob;
      const childEmail = stripEncryptedPlaceholder(depEmail);
      if (childEmail) contact[`Child_${childIndex}_Email`] = childEmail;
      const childPhone = normalizePhone(depPhone);
      if (childPhone) contact[`Child_${childIndex}_Phone_Number`] = childPhone;
      const childSsn = normalizeSsn(depSsn);
      if (childSsn) contact[`Child_${childIndex}_S_S_Number`] = childSsn;
      if (depAddress) contact[`Child_${childIndex}_Address`] = depAddress;
      childIndex++;
    }
  });

  return contact;
}

async function logSyncAttempt(
  supabase: ReturnType<typeof createClient>,
  entry: {
    customer_email: string;
    zoho_contact_id: string | null;
    sync_type: string;
    sync_status: string;
    error_message: string | null;
    agent_id: string | null;
    request_payload?: Record<string, unknown>;
    response_payload?: Record<string, unknown>;
    monthly_premium?: number;
  }
): Promise<void> {
  try {
    await supabase.from("zoho_sync_log").insert({
      customer_email: entry.customer_email,
      zoho_contact_id: entry.zoho_contact_id,
      sync_type: entry.sync_type,
      sync_status: entry.sync_status,
      error_message: entry.error_message,
      agent_id: entry.agent_id,
      request_payload: entry.request_payload || null,
      response_payload: entry.response_payload || null,
      monthly_premium: entry.monthly_premium || null,
    });
  } catch {
    // Logging failure should not break the main flow
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ success: false, error: "Database configuration error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let payload: ZohoSyncPayload;
  let customerEmail = "";
  let agentId: string | null = null;

  try {
    try {
      payload = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    customerEmail = payload.email || "";
    agentId = payload.agentId || null;

    let decrypted: DecryptedClientData = {
      ssn: payload.ssn || "",
      phone: payload.phone || "",
      email: payload.email || "",
      dob: payload.dob || "",
      dependentSsns: [],
      dependentPhones: [],
      dependentEmails: [],
      dependentDobs: [],
    };

    if (payload.encrypted) {
      try {
        decrypted = await decryptSensitivePayload(payload.encrypted);
        customerEmail = decrypted.email || payload.email;
      } catch (decryptError) {
        await logSyncAttempt(supabase, {
          customer_email: customerEmail,
          zoho_contact_id: null,
          sync_type: "failed",
          sync_status: "failed",
          error_message: `Decryption failed: ${decryptError instanceof Error ? decryptError.message : "Unknown error"}`,
          agent_id: agentId,
          monthly_premium: payload.selectedPrice,
        });

        return new Response(
          JSON.stringify({ success: false, error: "Failed to decrypt payload" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    const zohoClientId = Deno.env.get("ZOHO_CLIENT_ID");
    const zohoClientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
    const zohoRefreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");

    if (!zohoClientId || !zohoClientSecret || !zohoRefreshToken) {
      await logSyncAttempt(supabase, {
        customer_email: customerEmail,
        zoho_contact_id: null,
        sync_type: "failed",
        sync_status: "failed",
        error_message: "Missing Zoho configuration",
        agent_id: agentId,
        monthly_premium: payload.selectedPrice,
      });

      return new Response(
        JSON.stringify({ success: false, error: "Zoho configuration missing" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let accessToken: string;
    try {
      accessToken = await getZohoAccessToken();
    } catch (authError) {
      await logSyncAttempt(supabase, {
        customer_email: customerEmail,
        zoho_contact_id: null,
        sync_type: "failed",
        sync_status: "failed",
        error_message: `Zoho auth failed: ${authError instanceof Error ? authError.message : "Unknown error"}`,
        agent_id: agentId,
        monthly_premium: payload.selectedPrice,
      });

      return new Response(
        JSON.stringify({ success: false, error: "Zoho authentication failed" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let ownerName: string | undefined;
    if (agentId) {
      const { data: advisorData } = await supabase
        .from("advisor")
        .select("advisor_name")
        .eq("sales_id", parseInt(agentId))
        .maybeSingle();

      if (advisorData?.advisor_name) {
        ownerName = advisorData.advisor_name;
      }
    }

    const contactPayload = buildZohoContactPayload(payload, decrypted, ownerName);

    const safeRequestPayload = {
      firstName: payload.firstName,
      lastName: payload.lastName,
      city: payload.city,
      state: payload.state,
      zipcode: payload.zipcode,
      benefitId: payload.benefitId,
      effectiveDate: payload.effectiveDate,
      dependentCount: payload.dependents?.length || 0,
    };

    let existingContact: ZohoContact | null = null;
    try {
      existingContact = await searchContactByEmail(accessToken, customerEmail);
    } catch (searchError) {
      const errorMsg = searchError instanceof Error ? searchError.message : "Unknown error";
      if (errorMsg.includes("429") || errorMsg.toLowerCase().includes("rate limit")) {
        await logSyncAttempt(supabase, {
          customer_email: customerEmail,
          zoho_contact_id: null,
          sync_type: "failed",
          sync_status: "failed",
          error_message: "Rate limited by Zoho",
          agent_id: agentId,
          request_payload: safeRequestPayload,
          monthly_premium: payload.selectedPrice,
        });

        return new Response(
          JSON.stringify({ success: false, error: "Rate limited" }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    let result: { id: string; action: "create" | "update" };
    try {
      result = await createOrUpdateContact(
        accessToken,
        contactPayload,
        existingContact?.id
      );
    } catch (upsertError) {
      const errorMsg = upsertError instanceof Error ? upsertError.message : "Unknown error";

      if (errorMsg.includes("429") || errorMsg.toLowerCase().includes("rate limit")) {
        await logSyncAttempt(supabase, {
          customer_email: customerEmail,
          zoho_contact_id: null,
          sync_type: "failed",
          sync_status: "failed",
          error_message: "Rate limited by Zoho",
          agent_id: agentId,
          request_payload: safeRequestPayload,
          monthly_premium: payload.selectedPrice,
        });

        return new Response(
          JSON.stringify({ success: false, error: "Rate limited" }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      await logSyncAttempt(supabase, {
        customer_email: customerEmail,
        zoho_contact_id: null,
        sync_type: "failed",
        sync_status: "failed",
        error_message: errorMsg,
        agent_id: agentId,
        request_payload: safeRequestPayload,
        monthly_premium: payload.selectedPrice,
      });

      return new Response(
        JSON.stringify({ success: false, error: "Zoho sync failed", details: errorMsg }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    await logSyncAttempt(supabase, {
      customer_email: customerEmail,
      zoho_contact_id: result.id,
      sync_type: result.action,
      sync_status: "success",
      error_message: null,
      agent_id: agentId,
      request_payload: safeRequestPayload,
      response_payload: { zoho_contact_id: result.id, action: result.action },
      monthly_premium: payload.selectedPrice,
    });

    return new Response(
      JSON.stringify({
        success: true,
        zohoContactId: result.id,
        action: result.action,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await logSyncAttempt(supabase, {
      customer_email: customerEmail,
      zoho_contact_id: null,
      sync_type: "failed",
      sync_status: "failed",
      error_message: errorMessage,
      agent_id: agentId,
    });

    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
