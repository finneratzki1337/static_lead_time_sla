# AIRFREIGHT SERVICE LEVEL ESTIMATOR (Static)

**Best possible lead time — not considering variability, strikes, weather, offloads***  \
*This tool uses deterministic inputs and ideal operational conditions. Real-world performance may be worse.*

## What this is
This repository hosts a fully static, client-side web app that models airfreight lead time outcomes from minute-level order placement, flight schedules, and processing times. It outputs:

1. **Service level (%) vs lead time target (hours)**
2. **Distribution of requests per flight (%)** including **“First flight next day”**
3. **Lead time target vs achievable service level** table
4. **Interactive lookup** for an arbitrary lead time target

Lead time is measured from order placement to final completion. The app uses deterministic inputs and searches the earliest feasible flight across the current and next three days.

## GitHub Pages enablement
1. Go to **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, choose **Source: Deploy from a branch**.
3. Select **Branch: `main`** and **Folder: `/ (root)`**.
4. Save. The site will be served from `https://<org-or-user>.github.io/<repo>/`.

## Usage notes
- Use the **Incoterm** selector to apply DPU/DAP defaults for customs clearance and last mile, then adjust as needed.
- Input flight departures as comma-separated `HH:MM` times (24-hour clock).
- Choose a distribution mode to model order placement over the day.
- The **Resolution** selector controls the granularity of the service-level chart and table.

## Screenshot
_Add a screenshot here after deployment (recommended)._ 
