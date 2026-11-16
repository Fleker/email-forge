# Agent Instructions for Mail Forge (`AGENTS.md`)

## 1. Architecture Overview

Mail Forge is a stateless, multi-account Gmail triage web app built with **Angular 20** (standalone components + Angular Signals) and **Angular Material**:

- **`src/app/models/mail.model.ts`**: Core data structures (`GmailAccount`, `RawEmailMessage`, `CategorizedEmail`, `CategoryPlugin`, `CategoryViewTemplate`, and strongly-typed metadata interfaces for each category).
- **`src/app/services/category-registry.service.ts`**: Priority-ordered classification and metadata extraction pipeline (`CategoryRegistryService`). Evaluates every `RawEmailMessage` against registered `CategoryPlugin`s (highest `priority` first) and falls back to `'inbox'` (`People & Direct`).
- **`src/app/services/gmail-api.service.ts`**: Multi-account OAuth 2.0 token manager (`access_type=offline` + automatic `refresh_token` renewal), parallel Gmail REST API fetcher (`messages.list`, `messages.get?format=full`), MIME base64url decoder, and mutation client (`archiveEmail`, `archiveBatch`, `toggleStar`, `markAsRead`, `forwardEmail`).
- **`src/app/app.component.ts` / `.html` / `.scss`**: Main workspace shell featuring the top account-pill switcher, global floating 2FA banner, left category navigation rail, and `@switch (activeViewTemplate())` viewport.

---

## 2. How to Add a New Category UI

There are two ways to add a category depending on whether it needs a **custom Angular Material layout** or uses standard **metadata cards**.

### Path A: Adding a Full Custom Category UI in Code (Step-by-Step)

Follow these 5 steps whenever adding a first-class category with its own specialized UI:

#### Step 1: Define the Category ID, View Template, and Metadata Interface (`src/app/models/mail.model.ts`)
1. Add the new category identifier to `BuiltInCategoryId`:
   ```ts
   export type BuiltInCategoryId =
     | 'inbox'
     | 'two_factor'
     | 'orders'
     | 'bills'
     | 'events'
     | 'notifications'
     | 'newsletters'
     | 'travel'; // <-- New category ID
   ```
2. Add a corresponding template name to `CategoryViewTemplate`:
   ```ts
   export type CategoryViewTemplate =
     | 'unified_inbox'
     | 'two_factor_vault'
     | 'orders_tracker'
     | 'bills_ledger'
     | 'events_agenda'
     | 'notifications_rollup'
     | 'newsletters_reader'
     | 'travel_itinerary' // <-- New view template
     | 'custom_cards';
   ```
3. Define a strongly-typed metadata interface and attach it as an optional property on `CategorizedEmail`:
   ```ts
   export interface TravelMetadata {
     airlineOrHotel: string;
     confirmationCode: string;
     departureTime?: string;
     origin?: string;
     destination?: string;
     checkinUrl?: string;
   }

   export interface CategorizedEmail {
     raw: RawEmailMessage;
     categoryId: CategoryId;
     // ...existing metadata fields
     travelMeta?: TravelMetadata;
   }
   ```

#### Step 2: Register the Plugin Matcher & Metadata Extractor (`src/app/services/category-registry.service.ts`)
1. Create a factory method `private createTravelPlugin(): CategoryPlugin` in `CategoryRegistryService`:
   - Choose an appropriate `priority` (higher numbers run earlier: `two_factor = 100`, `orders = 90`, `bills = 85`, `events = 80`, `custom = 75`, `notifications = 70`, `newsletters = 60`).
   - Implement `match(email: RawEmailMessage): boolean` using headers, sender domains, subject patterns, or embedded `application/ld+json` (`schema.org/FlightReservation`, `LodgingReservation`).
   - Implement `enrich(email: RawEmailMessage): Partial<CategorizedEmail>` to extract structured fields into `{ travelMeta }`.
2. Add `this.createTravelPlugin()` to `this.builtInPlugins` in `CategoryRegistryService`.
   - The left sidebar navigation rail (`@for (plugin of plugins(); track plugin.id)`) and badge counter (`categoryCounts`) automatically pick up any plugin registered in `builtInPlugins`.

#### Step 3: Add Computed Summaries or Actions (`src/app/app.component.ts`)
- If your category UI displays KPI summary cards, grouping, or specialized batch actions (like `archiveDeliveredOrders()` or `archiveRepoGroup()`), add a `computed()` signal or action method on `AppComponent` (or extract a dedicated standalone child component under `src/app/components/`).

#### Step 4: Render the View Template (`src/app/app.component.html` & `src/app/app.component.scss`)
- Inside `<main class="category-viewport">`, add a new `@case ('travel_itinerary')` block inside `@switch (activeViewTemplate())`:
  ```html
  @case ('travel_itinerary') {
    <section class="view-container">
      <header class="view-header">
        <div>
          <h2 class="view-title">
            <mat-icon style="color: #0891b2">flight_takeoff</mat-icon>
            Travel & Reservations
          </h2>
          <p class="view-subtitle">Flight boarding passes, PNR codes, and hotel bookings.</p>
        </div>
      </header>
      <!-- Render activeEmails() using item.travelMeta -->
    </section>
  }
  ```
- Always include:
  - The account badge (`@if (getAccountForEmail(item); as acct)`) so the user can see which Gmail account owns each item.
  - One-click **Archive** (`archiveEmail(item, $event)`) and any domain-specific primary action (e.g., *Copy PNR*, *Check In*).
  - An `@empty` state block when `activeEmails()` has no items.

#### Step 5: Add Seed Data & Unit Tests (`src/app/services/gmail-api.service.ts` & `src/app/app.component.spec.ts`)
1. Add 1–2 realistic sample emails for the new category in `GmailApiService.getDefaultDemoMessages()`.
2. Add unit test assertions in `src/app/app.component.spec.ts` verifying:
   - `CategoryRegistryService.categorize()` matches the email and extracts all expected metadata fields.
   - Selecting the category switches `app.activeViewTemplate()` to the new template.
   - Any new batch or item action updates state accurately.
3. Run `npm test && npm run build` and verify 0 failures and 0 budget warnings.

---

### Path B: Adding a Lightweight Rule-Based Category (No Code Changes Needed)

If a new category only needs keyword matching (`senderKeywords`, `subjectKeywords`, `bodyKeywords`) and an optional regex badge extractor:
- Click **+ Add Category Rule** in the left sidebar UI, or call `categoryRegistry.registerCustomCategory(rule: CustomCategoryRule)`.
- Custom rules are persisted to `localStorage` under `mail_forge_custom_categories` and render automatically using the `custom_cards` view template with extracted regex chips.
