# Zoho `Child_N_Email` INVALID_DATA fix

Use this doc when porting the **"Email/Phone/SSN are optional for child dependents under 18"** behavior to a sibling project (e.g. `zoho-sync-contact_careplus`) and the Zoho `Contacts` create/update fails with:

```json
{
  "code": "INVALID_DATA",
  "details": { "expected_data_type": "email", "api_name": "Child_1_Email" },
  "message": "invalid data",
  "status": "error"
}
```

Also surfaces under different `api_name`s (e.g. `Spouse_Email`, `Child_2_Email`) — same root cause.

This is a **two-bug compound problem**. Fixing only one of the two will leave the failure intact.

**MEC-EssentialsEnrollment (this repo) reference fix:** commits

- `aa26966 feat: optional Email/Phone/SSN for child dependents under 18`
- `d452e2f fix(zoho-sync-contact_mec): omit empty child email/phone/SSN/address`
- `9b64044 fix(supabase): clear [ENCRYPTED] placeholder for empty dependent fields`

Files touched:

- [`supabase/functions/zoho-sync-contact_mec/index.ts`](../supabase/functions/zoho-sync-contact_mec/index.ts) — decryption restore + `buildZohoFields` child loop
- [`supabase/functions/enrollment-api-mec/index.ts`](../supabase/functions/enrollment-api-mec/index.ts) — same decryption restore (defense in depth, prevents the placeholder leaking into the downstream gateway)
- [`src/components/EnrollmentWizard.tsx`](../src/components/EnrollmentWizard.tsx), [`src/components/DependentsAddressSection.tsx`](../src/components/DependentsAddressSection.tsx), [`src/utils/dependentAgeValidation.ts`](../src/utils/dependentAgeValidation.ts) — frontend that produced the empty values in the first place

---

## Symptom

A real enrollment with a `Child` dependent younger than **18** who legitimately leaves Email / Phone / SSN blank causes the `zoho-sync-contact_mec` edge function to return:

```
"error": "Zoho create failed: {\"data\":[{\"code\":\"INVALID_DATA\",\"details\":{\"expected_data_type\":\"email\",\"api_name\":\"Child_1_Email\"},\"message\":\"invalid data\",\"status\":\"error\"}]}"
```

Children **18+** and Spouses do not trigger it because the form still requires their contact fields.

---

## Why it happens — full data trace

The bug is the interaction of **two** unrelated layers, each individually plausible but together fatal.

### Layer 1 — client placeholder when encryption is on

When the wizard sends the Zoho payload it encrypts sensitive fields and replaces them on the wire with the literal string `'[ENCRYPTED]'`. See [`EnrollmentWizard.tsx`](../src/components/EnrollmentWizard.tsx) `syncToZohoCRM` around line 994:

```ts
dependents: dependents.map(dep => ({
  ...
  email: encryptedZohoPayload ? '[ENCRYPTED]' : dep.email,
  phone: encryptedZohoPayload ? '[ENCRYPTED]' : dep.phone,
  ssn:   encryptedZohoPayload ? '[ENCRYPTED]' : dep.ssn,
})),
```

The real value (or `''` for a minor child who left it blank) lives **only** inside the parallel arrays `encrypted.dependentEmails`, `encrypted.dependentPhones`, `encrypted.dependentSsns`.

### Layer 2 — server "restore" step has a truthy gate

[`supabase/functions/zoho-sync-contact_mec/index.ts`](../supabase/functions/zoho-sync-contact_mec/index.ts) restores decrypted values into the `payload.dependents[i]` shape, but the **original** code only wrote back when the decrypted value was truthy:

```ts
if (decrypted.dependentEmails && decrypted.dependentEmails[index]) {
  dep.email = decrypted.dependentEmails[index];
}
```

For a minor child whose `dep.email` is `''`, the decrypted value is also `''` (falsy), the branch is skipped, and `dep.email` keeps the placeholder string `'[ENCRYPTED]'`.

### Result

`buildZohoFields` then sees `child.email === '[ENCRYPTED]'` (truthy, non-empty), happily sets `Child_1_Email = '[ENCRYPTED]'`, and posts to `https://www.zohoapis.com/crm/v2/Contacts`. Zoho's email-typed field rejects it with `expected_data_type: "email"`.

### Why phone and SSN looked fine

Pure luck. `normalizePhone` and `normalizeSsn` strip non-digits:

```ts
function normalizePhone(phone: string): string { /* ... */ return digits; }
function normalizeSsn(ssn: string):   string { return ssn.replace(/\D/g, ""); }
```

So `'[ENCRYPTED]' → ''` for those two and the empty value is silently emitted (or omitted, after the second part of the fix). Email had no analogous filter, so the placeholder reached Zoho verbatim.

---

## The fix — both layers

You need **all three** changes for the bug to actually go away on a sibling project. Fixing only the field-build conditional is **not enough**, because the field is never empty by the time the build runs.

### Fix A — server: restore decrypted values unconditionally per index

[`supabase/functions/zoho-sync-contact_mec/index.ts`](../supabase/functions/zoho-sync-contact_mec/index.ts) — replace the truthy gate with an existence-only gate so empty originals correctly overwrite the `'[ENCRYPTED]'` placeholder:

```ts
if (Array.isArray(payload.dependents)) {
  payload.dependents.forEach((dep, index) => {
    // Restore decrypted values unconditionally so an empty original ('')
    // overwrites the client placeholder string ('[ENCRYPTED]'). The previous
    // truthy-only check left the placeholder in place when a minor-child
    // dependent legitimately had no email/phone/SSN, which caused Zoho to
    // reject Child_N_Email = '[ENCRYPTED]' as INVALID_DATA.
    if (decrypted.dependentSsns && index < decrypted.dependentSsns.length) {
      dep.ssn = decrypted.dependentSsns[index] || "";
    }
    if (decrypted.dependentPhones && index < decrypted.dependentPhones.length) {
      dep.phone = decrypted.dependentPhones[index] || "";
    }
    if (decrypted.dependentEmails && index < decrypted.dependentEmails.length) {
      dep.email = decrypted.dependentEmails[index] || "";
    }
    if (decrypted.dependentDobs && decrypted.dependentDobs[index]) {
      dep.dob = decrypted.dependentDobs[index];
    }
  });
}
```

DOB is intentionally left as truthy-gated because DOB is required and never legitimately empty. If your sibling project has more optional encrypted dependent fields, apply the same `index < length` + `|| ""` pattern to each.

### Fix B — `buildZohoFields`: omit Zoho keys for empty values

Even with Fix A, you still need to **not send empty strings** to Zoho's typed fields. Replace the unconditional assignments in the child (and optionally spouse) loop:

```ts
for (let index = 0; index < children.length; index++) {
  const child = children[index];
  const num = index + 1;

  fields[`Child_${num}`]     = `${child.firstName} ${child.lastName}`;
  fields[`Child_${num}_DOB`] = convertDateToZoho(child.dob);

  // Email/Phone/SSN are optional for child dependents under 18. Zoho rejects
  // empty strings on typed fields (e.g. INVALID_DATA on Email), so omit the
  // key entirely when there's no usable value rather than sending "".
  const childEmail = (child.email || "").trim();
  if (childEmail) {
    fields[`Child_${num}_Email`] = childEmail;
  }
  const childPhone = normalizePhone(child.phone || "");
  if (childPhone) {
    fields[`Child_${num}_Phone_Number`] = childPhone;
  }
  const childSsn = normalizeSsn(child.ssn || "");
  if (childSsn) {
    fields[`Child_${num}_S_S_Number`] = childSsn;
  }

  const childAddress = buildDependentAddress(child, payload);
  if (childAddress) {
    fields[`Child_${num}_Address`] = childAddress;
  }
}
```

Important behavior: for an existing Zoho contact being **updated**, omitting the key means Zoho leaves whatever value it currently holds untouched. That is almost always what you want for optional fields. If your project requires explicitly clearing a field, send `null` (Zoho v2 supports `null` to clear a field) — empty string is still rejected.

### Fix C — same restore fix in any other server function that touches dependents

If your project has a parallel function (e.g. `enrollment-api-mec`, `gateway-member-api_*`, `enrollment-api-careplus`) that also decrypts and re-emits dependent fields, **apply Fix A there too**. Otherwise the `'[ENCRYPTED]'` placeholder will leak into the next downstream call (carrier gateway, accounting export, etc.) and resurface as a different error months later.

In this repo, [`supabase/functions/enrollment-api-mec/index.ts`](../supabase/functions/enrollment-api-mec/index.ts) had the same anti-pattern in its decryption block (around line 401) and is fixed identically.

### Fix D (optional but recommended) — frontend: don't require the fields for minor children

Strictly speaking the Zoho fix above is sufficient — Zoho will accept the field being absent. But if your app's UI also enforces "Email/Phone/SSN required for every dependent", users still cannot submit. The MEC-EssentialsEnrollment side ships a small frontend change for that:

- New helper `isMinorChildDependent(dep)` and `OPTIONAL_FOR_MINOR_CHILD_LABEL_SUFFIX` in [`src/utils/dependentAgeValidation.ts`](../src/utils/dependentAgeValidation.ts), keyed off the same `calculateAgeFromDOB` used elsewhere.
- Step 3 validator (`validateStep3` in [`EnrollmentWizard.tsx`](../src/components/EnrollmentWizard.tsx)) gates only the empty/required branches — format and duplicate checks still run when a value is provided.
- Per-field UI in [`DependentsAddressSection.tsx`](../src/components/DependentsAddressSection.tsx) replaces the red `*` with a small `(optional)` and flips `aria-required` to `false` when the selected dependent is a minor child.

See [`docs/optional_child_contact_fields_6750e3ad.plan.md`](optional_child_contact_fields_6750e3ad.plan.md) for the design notes on that piece.

---

## Decision matrix — which fixes do I actually need?

| Sibling project state | Fix A (server restore) | Fix B (omit keys) | Fix C (other functions) | Fix D (frontend optional) |
|---|---|---|---|---|
| Encrypts dependent fields with `'[ENCRYPTED]'` placeholder pattern | **Yes** | **Yes** | Yes if any other server fn decrypts | Recommended |
| Sends raw plaintext (no encryption) and currently sends `""` | No | **Yes** | n/a | Recommended |
| No encryption, omits keys when value is empty already | No | Already good | n/a | Recommended |
| You want to clear a previously-set value on an existing Zoho contact | n/a | Send `null` instead of omitting | n/a | n/a |

**Smell test for whether you have the placeholder bug:** open the relevant edge-function file and search for `'[ENCRYPTED]'`. If it appears as a value being assigned to `dep.email` / `dep.phone` / `dep.ssn` on the **client**, you must apply Fix A on the **server**.

---

## Verification recipe

After deploying:

```bash
supabase functions deploy zoho-sync-contact_<your-project>
supabase functions deploy enrollment-api-<your-project>   # if you applied Fix C
```

Then in the live app:

1. **Minor-child happy path** — add a `Child` whose DOB makes them age `10`. Leave Email/Phone/SSN blank. Submit. Expect: Zoho contact created; the `Child_1_Email` / `_Phone_Number` / `_S_S_Number` fields are simply absent on the contact in Zoho UI.
2. **Adult-child path** — `Child` age `22` with full Email/Phone/SSN. Expect: Zoho contact populated as before, no regression.
3. **Spouse path** — `Spouse` with full contact. Expect: Zoho contact populated; this fix did not touch spouse fields. (If you choose to mirror the conditional pattern to spouse, do it consciously — only meaningful in projects where the spouse's contact fields are themselves optional.)
4. **Format-error path** — `Child` age `10` with a malformed email. Expect: client-side error before submit; if you bypass the client, Zoho still rejects but only for the bad email, not for blanks.
5. **Existing-contact update** — submit a second time with the same primary email so the function takes the **update** path (`searchContactByEmail` returns an id). Expect: minor child's blank fields **do not overwrite** any pre-existing values on that contact (because the keys are omitted, not set to `null`).

To confirm a fresh deploy actually picked up the new code, tail the logs while submitting:

```bash
supabase functions logs zoho-sync-contact_<your-project> --tail
```

You should see `Decryption successful, applying decrypted values` and **no** subsequent `'[ENCRYPTED]'` strings appearing in the JSON body posted to `https://www.zohoapis.com/crm/v2/Contacts`.

---

## Checklist for porting to a sibling project

- [ ] Identify the encrypted-field pattern. Search the **client** for `'[ENCRYPTED]'` assigned to `dep.email` / `dep.phone` / `dep.ssn` (or your project's equivalent).
- [ ] Identify every **server** function that decrypts and re-emits those fields. Grep for `decrypted.dependentEmails` / `dependentPhones` / `dependentSsns`.
- [ ] In each such function, change the truthy gate `if (decrypted.X && decrypted.X[i])` to an existence gate `if (decrypted.X && i < decrypted.X.length) { dep.field = decrypted.X[i] || ""; }`. **Do not** apply this to required-only fields like DOB.
- [ ] In the Zoho field builder (`buildZohoFields` or equivalent), wrap each optional `Child_N_*` and (optionally) `Spouse_*` assignment in `if (value) { fields[key] = value; }` after normalization. Do this for **email, phone, SSN, address** (anywhere the source field can be empty).
- [ ] Decide explicitly whether to mirror the pattern to **spouse** fields. Only do it in projects where the form makes spouse contact optional too.
- [ ] Mirror the fix in any **other** function in the same chain (`enrollment-api-*`, `gateway-member-api_*`, etc.) so the placeholder cannot leak downstream.
- [ ] Update the **frontend** so users can actually submit without those fields (Fix D), keyed off whatever rule defines "minor child" in your project (here: `relationship === 'Child' && calculateAgeFromDOB(dob) < 18`).
- [ ] Deploy each touched edge function: `supabase functions deploy <name>`.
- [ ] Verify with the live recipe above; confirm the deploy timestamp post-dates your push so you know you're testing the new code.

---

## Related docs

- [`docs/optional_child_contact_fields_6750e3ad.plan.md`](optional_child_contact_fields_6750e3ad.plan.md) — frontend-side design for making the three fields optional under 18.
- [`docs/duplicate-ss-and-phone.md`](duplicate-ss-and-phone.md) — duplicate-detection rules that **still** run when a minor child voluntarily fills in Email/Phone/SSN.
- [`docs/dependent-email-duplicate-blur-validation-pattern.md`](dependent-email-duplicate-blur-validation-pattern.md) — companion pattern for email-side duplicates.

---

## Applied in this repo (PremiumHSAEnrollment)

This fix has been ported to this repo. Adaptations vs. the MEC reference above:

- **Client placeholder is lowercase `[encrypted]`** (not `[ENCRYPTED]`). See `EnrollmentWizard.tsx` lines 927–951. The server helper `stripEncryptedPlaceholder` accepts both casings defensively.
- **Server function names are different:**
  - Zoho sync — [`supabase/functions/zoho-sync-contact_premiumhsa/index.ts`](../supabase/functions/zoho-sync-contact_premiumhsa/index.ts)
  - Enrollment API — [`supabase/functions/enrollment-api-premiumhsa/index.ts`](../supabase/functions/enrollment-api-premiumhsa/index.ts)
- **Fix A is folded into `buildZohoContactPayload`,** not a separate `mergeDecryptedFields` step like MEC's Zoho function. The equivalent is the helper `resolveDependentField(decryptedArr, idx, clientFallback)`: it prefers the decrypted-array value at that index even when the value is empty (which is the whole point — it overwrites `[encrypted]` for legitimately blank optional fields).
- **Fix B applied to both Child *and* Spouse fields** as defense-in-depth: omit `Child_N_Email/Phone/SSN/Address/DOB` and `Spouse_Email/Phone/Social_Security/Address/DOB` when normalization produces an empty string. The frontend still requires spouse contact, so spouse omission should never fire in normal flow, but it costs nothing and prevents a future regression.
- **Fix C is not needed in `enrollment-api-premiumhsa`** — it already uses the existence-gated pattern in `mergeDecryptedFields` (`if (index < dependents.length && email !== undefined)`), so empty strings correctly overwrite the placeholder before the gateway call.
- **Fix D was shipped earlier** in commit `6c43eec` ("feat(enrollment): make dependent email/phone/SSN optional for child dependents under 18"). Helper lives in `src/utils/dependentAgeValidation.ts` as `isChildDependentUnder18ForContactOptional(dob, relationship)`.

**Deploy:** `supabase functions deploy zoho-sync-contact_premiumhsa`. The enrollment Edge function does not need redeployment for this fix.
