# Commodity Bad Debt alert (Q37)

Hourly check of **Updated Auto-fund movement calculations → Commodity Bad debt → Q37** (Gold OI greater than 20x). Data in that sheet refreshes every hour between **:25 and :32**; the script evaluates the cell at **:33**.

| Severity | Condition |
|---|---|
| **Amber** | Q37 **> 3.5mm** (3,500,000) |
| **Red** | Q37 **> 4.0mm** (4,000,000) |
| **Black** | Q37 **> 5.5mm** (5,500,000) |
| Cleared | Q37 drops back to **≤ 3.5mm** after an alert |

Current screenshot value (~1.99mm) is below all thresholds, so no alert would send.

## What the email looks like

From: **Commodity Bad Debt Alert**  
Same HTML for Gmail (inline CSS + tables).

| Condition | When | Sample subject | Color |
|---|---|---|---|
| **Amber (first snap)** | Q37 first **> 3.5mm** | `[AMBER] Commodity bad debt Q37 = 3.72mm … ↑ +1.72mm` | Gold `#F9AB00` |
| **Persistent (2nd snap)** | Still above 3.5mm | `[AMBER] Persistent 2 snaps · … ↑ +0.19mm` | Gold, last-2-snaps table |
| **Red / Black** | Crosses 4.0mm / 5.5mm | `[RED] Persistent 2 snaps · …` / `[BLACK] Persistent 3 snaps · …` | Red / Black |
| **Cleared (later snap)** | Back to **≤ 3.5mm** | `[CLEARED] … ↓ −1.91mm` | Green `#188038` |

Body: colored header, Q37 value, **↑ / ↓ vs last snap**, last 2 snaps table, breach time, threshold ladder, **Open spreadsheet**.

Previews: [`email-samples/index.html`](email-samples/index.html) (open in a browser) or the PNGs in [`email-samples/`](email-samples/).

To receive all four in your real inbox after the script is pasted into Apps Script, run **`sendSampleAlertEmails`**. Subjects are prefixed `[SAMPLE]` so they are not confused with live alerts.

## Which channel to use

**Start with email.** Google Apps Script can send Gmail from the account that owns the script. No Slack app, webhook, or extra quota setup. That is the fastest way to get paged after the :33 check.

**Add Slack** if the on-call team already lives in Slack (this repo’s other pipeline does). Incoming webhooks are one extra Script Property. Email and Slack can run together.

Other options (not in this script):

- **Google Chat** incoming webhook — same pattern as Slack if the desk uses Chat.
- **SMS / PagerDuty** — better for Black only; needs a third-party API key.

Recommendation: **email now**, Slack when the webhook URL is ready.

## You need edit access

The live Auto-fund sheet is often **View only**. Apps Script can only be attached (Extensions → Apps Script) by someone with **edit** access. Pick one:

1. **Preferred** — get edit access on the Auto-fund spreadsheet, then bind the script there.
2. **View-only workaround** — create a spreadsheet you own, put `=IMPORTRANGE("<auto-fund-url>","'Commodity Bad debt'!Q37")` in `Q37` of a tab named `Commodity Bad debt`, and bind the script to *your* sheet. Authorize the IMPORTRANGE once.

## Deploy (email)

1. Open the spreadsheet that the script should read (the live Auto-fund file, or your IMPORTRANGE helper).
2. **Extensions → Apps Script**. Delete any stub `myFunction`.
3. Paste [`Code.gs`](Code.gs). Optional: File → Project settings → copy [`appsscript.json`](appsscript.json) (timezone `Asia/Kolkata`).
4. In `CONFIG.EMAIL.TO`, list everyone who should get the mail. Add `CC` if needed.
5. Save. Run **`testAlertNow`** (Run ▶). Grant permissions (Sheets + Gmail).
6. Check your inbox. The test always sends, even when Q37 is still ~2mm (subject will be `[CLEARED]` / below threshold).
7. Run **`installTrigger`**. That creates a **every 5 minutes** clock trigger; the function itself only acts at **:33–:37** and at most once per hour, so it lands after the :25–:32 refresh.

Apps Script cannot schedule “exactly minute 33” on an hourly trigger (`nearMinute` is ±15 minutes). The 5-minute trigger plus a :33–:37 window is the reliable pattern.

## Optional Slack

1. In Slack: create an Incoming Webhook (or use an existing ops channel webhook).
2. In Apps Script: **Project Settings → Script properties** → add `SLACK_WEBHOOK_URL` = the webhook URL. Do not commit the URL.
3. Set `CONFIG.SLACK.ENABLED` to `true`.
4. Run **`testAlertNow`** again and confirm the channel post.

## Behaviour (hourly snaps)

Each :33 check is one **snap**. The script stores the previous snap and compares.

| Snap | What happened | Email |
|---|---|---|
| **1** | Q37 first goes above 3.5mm | Amber / Red / Black. “First hourly snap in breach.” |
| **2** | Still above 3.5mm after the next hourly refresh | Same (or worse) color. **Last 2 snaps** table + **↑ increase or ↓ decrease** vs the previous snap + “Persistent — breaching across last 2 snaps (~2 hours).” |
| **3+** | Still breaching | Same persist mail, snap count / hours keep rising, still shows last 2 snaps and up/down. |
| **Later snap** | Q37 back to **≤ 3.5mm** | **Green CLEARED**, last 2 snaps, decrease (or increase) vs previous, “Cleared after N hourly snaps in breach.” |

No mail while it stays below 3.5mm. A **Q37 Alert Log** tab is appended on each check if the script has edit access.

Helpers:

| Function | Purpose |
|---|---|
| `testAlertNow` | Read Q37 and send immediately (ignore the :33 window) |
| `sendSampleAlertEmails` | Send SAMPLE mails (first breach, persist 2 snaps, Red, Black, Cleared) |
| `dryRunCheck` | Read Q37, log payload, send nothing |
| `installTrigger` | Start the hourly :33 check |
| `uninstallTriggers` | Stop it |

## Tests

From the repo root:

```bash
npm test
```
