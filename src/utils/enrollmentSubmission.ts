/**
 * Client-side submission idempotency helpers.
 *
 * A single `submissionId` (UUID) is generated per enrollment attempt and reused
 * across retries until the attempt fully completes. The enrollment edge function
 * uses it to guarantee the member is created at most once, so re-submits or lost
 * responses never produce a duplicate member/charge.
 */

const STORAGE_KEY = 'enrollment_submission_id';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSubmissionId(id: string | null | undefined): boolean {
  return !!id && UUID_RE.test(id.trim());
}

/** UUID persisted in sessionStorage; reused across retries until cleared. */
export function getOrCreateSubmissionId(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (isValidSubmissionId(existing)) {
      return existing as string;
    }
  } catch {
    // sessionStorage unavailable (private mode/SSR) — fall through to a fresh id.
  }

  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore persistence failures; the generated id is still returned.
  }
  return id;
}

/** Remove the stored id once an attempt fully completes (call on thank-you). */
export function clearSubmissionId(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

export interface SubmissionStatusResult {
  success: boolean;
  status?: string;
  memberId?: string | null;
  pdfUrl?: string | null;
  gatewayAttempts?: number;
  lastError?: string | null;
  error?: string;
}

/**
 * GET the enrollment API with the `submissionId` query param to recover the
 * server-recorded state (e.g. `memberId`) after a 409 or a page refresh.
 */
export async function fetchSubmissionStatus(
  submissionId: string,
  agentParam: string,
): Promise<SubmissionStatusResult> {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const statusUrl = `${supabaseUrl}/functions/v1/enrollment-api-premiumhsa?id=${agentParam}&submissionId=${encodeURIComponent(submissionId)}`;

    const res = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
        'Cache-Control': 'no-cache, no-store',
      },
      cache: 'no-store',
    });

    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return { success: false, error: 'Invalid response from status endpoint' };
    }

    const data = await res.json();
    return {
      success: data.success === true,
      status: data.status,
      memberId: data.memberId ?? null,
      pdfUrl: data.pdfUrl ?? null,
      gatewayAttempts: data.gatewayAttempts,
      lastError: data.lastError ?? null,
      error: data.error,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to fetch submission status',
    };
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Generic exponential-backoff helper. */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 5000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
