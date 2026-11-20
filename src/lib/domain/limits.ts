/**
 * Length caps for user-typed free text. The server enforces them and the forms put the
 * same numbers in `maxlength`, so a field simply stops instead of failing on save.
 * No server, DB or Svelte imports: both sides import this file.
 */
export const BUILD_NAME_MAX = 200;
export const BUILD_RECIPIENT_MAX = 200;
export const BUILD_HOSPITAL_MAX = 200;
export const RUN_NOTE_MAX = 2000;
export const SPOOL_NOTE_MAX = 200;
export const ASSEMBLY_NOTE_MAX = 1000;
export const HANDOFF_RECIPIENT_MAX = 200;
export const HANDOFF_ORGANIZATION_MAX = 200;
export const HANDOFF_CONTACT_MAX = 300;
export const HANDOFF_LOCATION_MAX = 300;
export const HANDOFF_NOTES_MAX = 4000;
export const PHOTO_CAPTION_MAX = 300;
export const DESIGN_NAME_MAX = 100;
export const SPOOL_NAME_MAX = 100;
export const TEAM_NAME_MAX = 80;
