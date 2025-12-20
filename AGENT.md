# Airfreight Lead Time Estimator (Static Web App) — agent.md

## 0) One-line disclaimer (must be visible at the very top)
**Best possible lead time — not considering variability, strikes, weather, offloads\***  
\*This tool uses deterministic inputs and ideal operational conditions. Real-world performance may be worse.

---

## 1) Goal
Build a **fully static** single-page web app (“Airfreight Lead Time Estimator”) that runs on **GitHub Pages** (no backend).
Users configure operational parameters and see:
1) Chart: **Service level (%) vs lead time target (hours)**  
2) Chart: **Distribution of requests per flight (%)** + extra bar **“First flight next day”**  
3) Table: **Lead time target vs achievable service level**  
4) Interactive lookup: user enters **lead time target** → app returns **achievable service level (%)**

Everything is **English**, in a **modern 80s dark theme** inspired by:
https://finneratzki1337.github.io/static_time_oclock/

---

## 2) Definitions (what “lead time” means)
**Lead time is measured from “order placed time”.** (Confirmed requirement)

For each order placed at time `t_order`, compute the earliest feasible flight and final completion time `t_done`.
Lead time = `t_done - t_order`.

Incoterms:
- **DPU (at cargo terminal):** delivery completes at destination availability time (plus optional 0 times by default)
- **DAP (at customer door):** includes customs clearance and last mile delivery

Note: Even when defaults are set by Incoterm, the user can override customs/last-mile values.

---

## 3) Inputs (UI) and Defaults

### 3.1 Incoterm (Dropdown)
- Options:
  - `DPU (at cargo terminal)`
  - `DAP (at customer door)`
- On change, apply defaults:
  - If DPU: `Customs clearance = 0h`, `Last mile time = 0h`
  - If DAP: `Customs clearance = 2h`, `Last mile time = 1h`
- Keep the fields editable after defaulting (do not lock them).

### 3.2 Time parameters (Numeric inputs, hours)
Use hours in UI, internally convert to minutes.
Recommended UI: step = 0.25h, min = 0.

1) RFC time (ready for carriage at warehouse) — default **2h**  
2) Transit time to cargo terminal — default **1h**  
3) LAT (latest acceptance time, before departure) — default **2h**  
4) Flight time — default **10h**  
5) TOA (time of availability at destination) — default **2h**  
6) Customs clearance — default depends on Incoterm (DAP 2h / DPU 0h)  
7) Last mile time — default depends on Incoterm (DAP 1h / DPU 0h)

Validation:
- All times must be `>= 0`
- Show inline error messages (non-blocking UI, but block computation if invalid)

### 3.3 Flight departures (Text input)
- Input: comma-separated list of `HH:MM` times (24h format)
- Default: `09:00, 21:00`
Parsing rules:
- Split by comma, trim spaces
- Validate 00:00–23:59
- Convert to minutes-of-day
- De-duplicate, sort ascending
- If empty/invalid → show error and disable outputs

### 3.4 Order behavior distribution (Dropdown + controls + mini chart)
Dropdown modes:
1) **Uniform (flat over the day)** — default selected  
2) **Normal distribution (with peak & sigma)**  
   - Peak time input `HH:MM` (default `12:00`)
   - Sigma input in hours (default `3`)
   - Implement as **circular normal** on a 24h clock:
     - For each minute `m` (0..1439), distance `d = min(|m - mu|, 1440 - |m - mu|)`
     - weight = exp(-0.5 * (d / sigmaMinutes)^2)
     - normalize weights to sum=1
3) **Order everything before … (cutoff time)**  
   - Cutoff time input `HH:MM` (default `15:00`)
   - Probability uniform on minutes `[0, cutoff)` and 0 afterwards
   - Edge case cutoff=00:00 → treat as a spike at minute 0

Mini chart:
- Small line chart next to the dropdown showing density over 24h.
- X-axis: time-of-day; Y-axis: normalized density.

---

## 4) Output Resolution (Lead-time target axis)
Provide a “Resolution” selector:
- Dropdown: `1.0h`, `0.5h`, `0.25h`
- Default: **0.5h**
This affects:
- Chart #1 x-axis ticks
- Table #3 rows

Output #4 (lookup) must allow **free numeric input** (decimals), independent of resolution.

---

## 5) Core Computation Logic (Deterministic)
### 5.1 Convert all durations to minutes
- rfcM, transitM, latM, flightM, toaM, customsM, lastMileM

### 5.2 Compute lead time for each possible order minute-of-day
Compute for m = 0..1439.

Definitions:
- `t_order = m`
- `t_ready = t_order + rfcM`
- `t_terminal = t_ready + transitM`

Flight departures list: `depTOD[]` in minutes-of-day (sorted ascending).

We must find the earliest feasible departure `depAbs` satisfying acceptance:
- depAbs = dayOffset*1440 + depTOD
- acceptanceDeadline = depAbs - latM
- Condition: `t_terminal <= acceptanceDeadline`

Search algorithm (fast, deterministic):
- For dayOffset in [0..3]:
  - For each depTOD in depTOD[]:
    - depAbs = dayOffset*1440 + depTOD
    - if t_terminal <= depAbs - latM: choose this depAbs and stop
Fallback: dayOffset up to 3 should be sufficient with sane inputs.

Then compute:
- `t_available_dest = depAbs + flightM + toaM`
- `t_done = t_available_dest + customsM + lastMileM`
- `leadTimeMin = t_done - t_order`
- `leadTimeHours = leadTimeMin / 60`

Store per minute m:
- leadTimeHours[m]
- chosenDayOffset[m]
- chosenFlightTOD[m] (the depTOD chosen)

### 5.3 Weight everything by the order-time distribution
Compute p[m] from the selected distribution (normalize so sum p[m] = 1).

---

## 6) Outputs

### Output 1: Service level vs lead time target chart (CDF-like)
For targets T from 1h to maxLeadTimeHours in steps of `resolutionHours`:
- serviceLevel(T) = sum_{m} p[m] * I(leadTimeHours[m] <= T)

Chart:
- X-axis: Lead time target (hours)
- Y-axis: Service level (%), 0..100
- Use a line chart or bar chart (line preferred for smoothness).

### Output 2: Distribution of requests on flight (%), plus “First flight next day”
Same-day flight share bars:
- For each flight depTOD:
  - shareSameDay(depTOD) = sum_{m: chosenDayOffset[m] == 0 AND chosenFlightTOD[m] == depTOD} p[m]

Extra bar “First flight next day”:
- firstDepTOD = depTOD[0]
- shareFirstFlightNextDay = sum_{m: chosenDayOffset[m] >= 1 AND chosenFlightTOD[m] == firstDepTOD} p[m]

Convert to percent for chart.

Chart:
- Bars labeled with flight times (e.g., 09:00, 21:00) plus one bar “First flight next day”
- Y-axis: %

### Output 3: Table (Lead time target vs achievable service level)
Rows by target T (same grid as Output 1):
- Lead time target (h)
- Service level (%)

### Output 4: Interactive lookup (target → achievable service level)
Widget:
- Input numeric: lead time target in hours (decimals allowed; step 0.25 recommended)
- Output: Achievable service level (%) computed **directly**, not interpolated:
  - SL(T) = sum_{m} p[m] * I(leadTimeHours[m] <= T)

This ensures correctness for arbitrary thresholds.

---

## 7) UI / Theme Requirements (80s modern dark)
- Full-screen feeling layout on desktop; stacked and scroll-friendly on mobile.
- Dark background, subtle neon accents, clean typography (bold headline).
- Recommended font: Orbitron (or similar) + fallback.
- Use pure CSS for subtle effects (glow, gradient, optional scanlines).
- Keep it classy: limited palette, strong contrast, readable labels.
- Inputs grouped into cards:
  - “Parameters”
  - “Flights”
  - “Order Behavior”
  - “Outputs”

Interaction:
- Recompute outputs live on input changes with a 150ms debounce.
- Show inline validation messages, disable charts when invalid.

---

## 8) Tech Stack & Constraints
- Static files only:
  - `index.html`
  - `styles.css`
  - `app.js`
- No build tooling required.
- Use a chart library via CDN (pin version):
  - Recommended: **Chart.js**
- Must run on GitHub Pages.

---

## 9) State persistence
- Persist all user inputs to `localStorage`
- On load:
  - Try URL params first (optional but recommended)
  - Else use localStorage
  - Else defaults

Optional (nice-to-have):
- Add a “Share link” button that encodes current settings into query params.

---

## 10) Validation & Error Handling
- Time parsing HH:MM must be strict.
- Flight list must contain at least one valid time.
- Sigma must be > 0 in Normal mode.
- If any fatal validation fails:
  - Show clear message
  - Don’t render misleading outputs

---

## 11) Repository & GitHub Pages
- Keep everything in repo root for easy Pages hosting.
- Add `README.md` with:
  - How to enable GitHub Pages (main branch / root)
  - Short explanation of the model and the disclaimer
  - Screenshots/gif optional

---

## 12) Acceptance Criteria
- App loads and runs fully client-side on GitHub Pages.
- All inputs exist with correct defaults.
- Incoterm switching correctly sets customs/last-mile defaults (but remains editable).
- Outputs #1–#4 render and update instantly on parameter changes.
- Output #2 includes the extra “First flight next day” bar with correct logic.
- Default resolution is 0.5h; user can switch resolution.
- Visual theme matches a modern 80s dark vibe and is mobile-friendly.
