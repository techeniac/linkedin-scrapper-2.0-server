# LinkedIn Scraper - Code Review & Improvement Guide

This document lists all identified issues organized by priority. Use it as a checklist when improving the codebase.

---

## CRITICAL - Security (Fix Before Any Deployment)

### S1. Secrets committed to repository
**Backend:** `.env` contains live Supabase DB password, HubSpot Client ID/Secret, and JWT secret.
- **Fix:** Rotate ALL credentials immediately. Verify `.gitignore` includes `.env`. Run `git rm --cached .env` if tracked. Use a secrets manager or at minimum ensure `.env` is never committed.
- **Frontend:** `.env` is also committed (only has localhost URL now, but sets a bad precedent). Same fix.

### S2. OAuth CSRF vulnerability — `state` param is raw user UUID
**File:** `LinkedIn_Scrapper_Server/src/services/hubspotOAuthService.ts` line ~28
```typescript
// BAD: predictable state
return `...&state=${userId}`;
```
- **Fix:** Generate a cryptographically random nonce, store it in a temporary table or cache (keyed to userId + expiry), and validate it in the callback. Example:
```typescript
const state = crypto.randomBytes(32).toString('hex');
await storeOAuthState(userId, state, Date.now() + 600_000); // 10min expiry
return `...&state=${state}`;
```

### S3. OAuth callback has no authentication
**File:** `LinkedIn_Scrapper_Server/src/routes/hubspotRoutes.ts` line ~22
- The `/callback` endpoint accepts any `state` param and connects HubSpot tokens to whatever user ID it resolves to.
- **Fix:** Validate the `state` nonce (see S2) and verify it maps to a real, unexpired OAuth initiation.

### S4. CORS is wide open
**File:** `LinkedIn_Scrapper_Server/src/app.ts` line ~16
```typescript
app.use(cors()); // Accepts ALL origins
```
- **Fix:** Restrict to the Chrome extension origin:
```typescript
app.use(cors({
  origin: [`chrome-extension://${EXTENSION_ID}`, 'http://localhost:5173'],
  credentials: true,
}));
```

### S5. Hardcoded JWT_SECRET fallback
**File:** `LinkedIn_Scrapper_Server/src/config/env.ts`
```typescript
export const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
```
- **Fix:** Crash on startup if `JWT_SECRET` is missing:
```typescript
export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET is required");
```

### S6. XSS in OAuth callback HTML response
**File:** `LinkedIn_Scrapper_Server/src/routes/hubspotRoutes.ts` lines ~50-57
- `result.ownerId` and `error.message` are interpolated directly into HTML.
- **Fix:** Escape HTML entities or use a simple redirect instead of inline HTML.

### S7. HubSpot tokens stored in plain text in DB
**File:** `prisma/schema.prisma`
- **Fix (later):** Encrypt tokens at rest using a symmetric key (AES-256-GCM). For now, at minimum ensure DB access is locked down and credentials are not committed.

---

## HIGH - Functional Bugs & Data Integrity

### F1. No input validation on HubSpot sync endpoints
**Backend files:** `hubspotSyncRoutes.ts`, `hubspotSyncController.ts`
- `sync-lead`, `check-profile`, `update-contact` have zero express-validator rules.
- `update-contact` passes `req.body` directly to HubSpot with no property whitelist.
- **Fix:** Add validation schemas for each endpoint. Whitelist allowed properties for `update-contact`.

### F2. LinkedIn industry field sends URN, not readable name
**File:** `linkedin-scrapper/src/utils/linkedinApi.ts` line ~95
```typescript
industry: company["*companyIndustries"]?.[0], // Returns "urn:li:fs_industry:4"
```
- **Fix:** Either resolve the URN to a name via LinkedIn's API or map known URNs to strings.

### F3. Profile picture URL breaks when artifacts[2] doesn't exist
**File:** `linkedin-scrapper/src/utils/linkedinApi.ts`
```typescript
profilePicture: profile.profilePicture?.displayImageReference?.vectorImage?.rootUrl +
  profile.profilePicture?.displayImageReference?.vectorImage?.artifacts?.[2]?.fileIdentifyingUrlPathSegment,
```
- When `artifacts[2]` is `undefined`, this produces `"https://...undefinedundefined"`.
- **Fix:** Add a null check, fall back to `artifacts[0]`, or return `null`.

### F4. `fetchLinkedInCompany` doesn't check `response.ok`
**File:** `linkedin-scrapper/src/utils/linkedinApi.ts` line ~155
- A 401 or 429 response will try to parse the error body as company data.
- **Fix:** Add the same `if (!response.ok) throw new Error(...)` guard that `fetchLinkedInProfile` has.

### F5. Backend `syncLead` uses `hubspotOwnerId` as connectivity check
**File:** `LinkedIn_Scrapper_Server/src/controllers/hubspotSyncController.ts` line ~28
- `hubspotOwnerId` can be `null` even for connected users (when their email doesn't match a HubSpot owner).
- **Fix:** Check `hubspotAccessToken` instead, or check both `accessToken` and `refreshToken`.

### F6. Logout is a no-op — stolen tokens can't be revoked
**File:** `LinkedIn_Scrapper_Server/src/controllers/authController.ts` line ~37
- **Fix (simple):** Use short-lived JWTs (15min) + refresh tokens stored in DB that can be deleted on logout.
- **Fix (quick):** Add a token blacklist table checked in the auth middleware.

### F7. HubSpot OAuth polling interval never cleaned up on unmount
**File:** `linkedin-scrapper/src/components/ProfileCard.tsx` line ~122
```typescript
const interval = setInterval(async () => { ... }, 2000);
setTimeout(() => clearInterval(interval), 60000);
```
- If ProfileCard unmounts during the 60s window, the interval keeps running.
- **Fix:** Store the interval ID in a ref and clear it in a `useEffect` cleanup function.

### F8. No token expiry handling in the extension
- The JWT stored in `chrome.storage.local` is never checked for expiry.
- API calls fail silently with generic error messages when the token expires.
- **Fix:** Decode the JWT client-side to check `exp`, and auto-logout or prompt re-login when expired.

---

## MEDIUM - Code Quality & Maintainability

### M1. No shared types — interfaces duplicated across files
- `Experience` interface duplicated in `ProfileCard.tsx` and `CompanySelectionModal.tsx`
- `User` interface duplicated in `ProfileCard.tsx` and `api.ts`
- **Fix:** Create `src/types/` directory with shared type definitions.

### M2. Pervasive `any` types across both codebases
- Frontend: `profileData: any`, `user: any`, `payload: any`, all catch blocks
- Backend: `userModel.ts` return types, `authService.verifyToken`, `hubspotSyncService` throughout
- **Fix:** Define proper interfaces. Start with the most critical data paths (profile payload, HubSpot sync request/response).

### M3. SyncedProfileView.tsx is 790 lines of inline styles and logic
- **Fix:** Extract into sub-components:
  - `EditableField` — reusable inline-edit input
  - `SearchableDropdown` — owner/lifecycle stage picker
  - `ActionMenu` — 3-dot menu with "Update CRM"
  - Move inline styles to CSS classes or a CSS-in-JS approach

### M4. Duplicated date formatting utilities
- `formatDateRange` in `ProfileCard.tsx` and `formatDate` in `CompanySelectionModal.tsx`
- **Fix:** Extract to `src/utils/dateUtils.ts`.

### M5. All inline styles instead of CSS classes
- All three main components (`ProfileCard`, `SyncedProfileView`, `CompanySelectionModal`) use extensive inline styles.
- `onMouseEnter`/`onMouseLeave` handlers for hover effects instead of CSS `:hover`.
- **Fix:** Use CSS modules or a single stylesheet. Replace imperative hover handlers with CSS pseudo-classes.

### M6. Dynamic CSS injection into LinkedIn's document.head
**File:** `linkedin-scrapper/src/components/SyncedProfileView.tsx`
- Injects `@keyframes slideIn` on every mount.
- **Fix:** Include the animation in the content script's CSS or use inline animation via JS.

### M7. Backend has double request logging
**File:** `LinkedIn_Scrapper_Server/src/app.ts`
- Both `morgan("combined")` and custom `requestLogger` log every request.
- **Fix:** Remove one. Keep morgan for standard format or the custom logger for structured JSON.

### M8. `console.error` mixed with Winston logger
**File:** `LinkedIn_Scrapper_Server/src/services/hubspotOAuthService.ts`
- One stray `console.error` bypasses structured logging.
- **Fix:** Replace with `logger.error(...)`.

### M9. Empty catch block swallows errors
**File:** `LinkedIn_Scrapper_Server/src/services/hubspotSyncService.ts` line ~391
```typescript
} catch {}
```
- **Fix:** At minimum log the error: `catch (e) { logger.warn('URL parse failed', { url, error: e }); }`

### M10. Commented-out dead code in multiple files
- Backend `hubspotSyncService.ts`: 3 blocks of commented-out HubSpot property mappings
- Frontend `ProfileCard.tsx`: commented-out state declaration
- Frontend `App.tsx`: entire file is unused dead code
- **Fix:** Delete all dead code. If needed later, it's in git history.

### M11. Unused `hubspot.types.ts` fields
- `hubspotLeadStatus`, `hubspotConnectedOnSource`, `hubspotLeadSource` are defined in the type but never used (the code that used them is commented out).
- **Fix:** Remove from the interface or uncomment the code.

### M12. Route organization is confusing
- `hubspotSyncRoutes.ts` is mounted inside `hubspotRoutes.ts` (`router.use("/", hubspotSyncRoutes)`), not in the root `routes/index.ts`.
- **Fix:** Mount all route groups from `routes/index.ts` for clarity:
```typescript
router.use("/hubspot", hubspotRoutes);
router.use("/hubspot", hubspotSyncRoutes);
```

---

## LOW - Missing Infrastructure & DX

### L1. Zero tests in both codebases
- Backend has an empty `tests/` directory and Jest configured but no test files.
- Frontend has no test setup at all.
- **Fix:** Start with the most critical paths:
  - Backend: `authService` (JWT, password hashing), `hubspotSyncService` (payload construction)
  - Frontend: `linkedinApi.ts` (parsing logic), `api.ts` (error handling)

### L2. No ESLint or Prettier on the backend
- Frontend has ESLint configured. Backend has nothing.
- **Fix:** Add ESLint + Prettier to the backend. Consider a shared config if both repos are in the same monorepo.

### L3. Incomplete `.env.example` on the backend
- Missing `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_SCOPES`.
- **Fix:** Add all required variables to `.env.example`.

### L4. No startup validation of required env vars
- The server starts fine with empty HubSpot credentials; errors only appear at runtime.
- **Fix:** Validate all required env vars on startup and crash with a clear message if any are missing.

### L5. Unused Chrome extension permissions
- `tabs`, `cookies`, `scripting` are declared but not used.
- **Fix:** Remove unused permissions from `manifest.json`. Fewer permissions = more user trust.

### L6. Hardcoded placeholder in antibot.js
**File:** `linkedin-scrapper/public/assets/antibot.js` line ~28
```javascript
args[0] = "chrome-extension://xxxxxxxxxxxxxxxx/index.js";
```
- The extension ID is a dummy value. This means the antibot bypass is non-functional.
- **Fix:** Either inject the real extension ID at build time or use `chrome.runtime.getURL()`.

### L7. Hardcoded placeholder data in SyncedProfileView
**File:** `linkedin-scrapper/src/components/SyncedProfileView.tsx`
- "Notes: 2" and "Tasks: 3" are static hardcoded values, not fetched from any API.
- **Fix:** Either fetch real counts from HubSpot or remove these UI elements.

### L8. No form validation beyond HTML `required`
- Signup: no password strength check, no password confirmation, no email format validation.
- Login: only browser-native `required`.
- **Fix:** Add client-side validation (email regex, password min length). Server already validates on auth routes but not on sync routes.

### L9. API errors throw generic strings, discard server messages
**File:** `linkedin-scrapper/src/services/api.ts`
```typescript
if (!response.ok) throw new Error("Login failed"); // Server's actual error message is discarded
```
- **Fix:** Parse the response body for the server's error message:
```typescript
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  throw new Error(body.message || "Login failed");
}
```

### L10. `checkingSync` loading state can get stuck
**File:** `linkedin-scrapper/src/components/ProfileCard.tsx`
- If HubSpot is not connected, `checkSyncStatus` is never called but `checkingSync` starts as `true`.
- **Fix:** Initialize `checkingSync` as `false` and only set it to `true` when actually starting the sync check.

---

## Improvement Priority Roadmap

### Phase 1: Security (Do Now)
1. Rotate all committed credentials (S1)
2. Fix CORS to restrict origins (S4)
3. Remove JWT_SECRET fallback (S5)
4. Fix OAuth state CSRF (S2 + S3)
5. Sanitize HTML in callback response (S6)

### Phase 2: Data Integrity (This Sprint)
6. Add input validation on sync endpoints (F1)
7. Fix profile picture URL construction (F3)
8. Fix company fetch error handling (F4)
9. Fix industry URN → name mapping (F2)
10. Add token expiry handling in extension (F8)

### Phase 3: Code Quality (Next Sprint)
11. Create shared types (M1, M2)
12. Break up SyncedProfileView into sub-components (M3)
13. Extract shared utilities (M4)
14. Move inline styles to CSS (M5)
15. Clean up dead code (M10, M11)

### Phase 4: Infrastructure (Ongoing)
16. Add ESLint + Prettier to backend (L2)
17. Add env var validation on startup (L4)
18. Write tests for critical paths (L1)
19. Complete `.env.example` (L3)
20. Remove unused permissions (L5)

---

## Code Standards Going Forward

### Naming Conventions
- **Files:** `camelCase.ts` for utilities, `PascalCase.tsx` for React components
- **Variables/functions:** `camelCase`
- **Types/interfaces:** `PascalCase`
- **Constants:** `UPPER_SNAKE_CASE`

### Error Handling Pattern
```typescript
// Backend: Use service-level error classes
class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// Frontend: Parse server errors, show meaningful messages
try {
  const result = await api.syncLead(payload);
} catch (error) {
  showToast(error instanceof Error ? error.message : "Sync failed");
}
```

### API Response Format (already in place, enforce consistently)
```typescript
// Success
{ success: true, data: { ... }, message: "..." }

// Error
{ success: false, message: "...", errors: [...] }
```

### Component Structure Target
```
src/
├── components/
│   ├── ProfileCard/
│   │   ├── ProfileCard.tsx
│   │   ├── ProfileCard.css
│   │   └── index.ts
│   ├── SyncedProfileView/
│   │   ├── SyncedProfileView.tsx
│   │   ├── EditableField.tsx
│   │   ├── SearchableDropdown.tsx
│   │   └── index.ts
│   └── CompanySelectionModal/
│       ├── CompanySelectionModal.tsx
│       └── index.ts
├── types/
│   ├── linkedin.ts     # Experience, ProfileData, CompanyData
│   ├── user.ts         # User, AuthState
│   └── hubspot.ts      # SyncPayload, ContactData
└── utils/
    ├── linkedinApi.ts
    ├── dateUtils.ts
    └── validation.ts
```
