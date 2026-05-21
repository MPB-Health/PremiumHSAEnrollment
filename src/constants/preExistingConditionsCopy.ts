/**
 * Step 3 "Limitations on Pre-Existing Conditions" — shared by UI and enrollment PDF.
 */
export const PRE_EXISTING_CONDITIONS_TITLE = 'Limitations on Pre-Existing Conditions';

export const PRE_EXISTING_CONDITIONS_INTRO =
  "Any pre-existing medical condition whether diagnosed or not, that has been active or needed treatment within 36 months prior to a Member's membership start date is subject to sharing limitations. Pre-existing conditions will become eligible for sharing based on the Member's tenure with the Sedera Medical Cost Sharing Community, as indicated by the following graduated sharing schedule.";

export const PRE_EXISTING_CONDITIONS_SCHEDULE_LINES = [
  { emphasis: 'First 12 months', rest: ' – Not shareable.' },
  { emphasis: 'Months 13-24', rest: ' – Shareable up to $25,000.' },
  { emphasis: 'Months 25-36', rest: ' – Shareable up to $50,000.' },
  { emphasis: 'Months 37 and after', rest: ' – shareable.' },
] as const;
