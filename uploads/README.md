# Prospect Organizer

A local-only Manifest V3 Chrome extension for organizing prospect records that
the user imports directly. It implements the safe portions of
`implementation_plan.md`: normalization, configurable qualification and
scoring, deduplication, local persistence, filtering, sorting, manual entry,
bulk status workflows, session activity history, selection, settings, CSV
export, JSON backup, and dark/light themes.

## Safety boundaries

This implementation intentionally does **not**:

- scrape Instagram follower/following lists;
- intercept private Instagram APIs;
- infer gender or other sensitive traits from names, bios, or faces;
- automate following, messaging, or anti-detection behavior;
- upload imported records or analytics to a server.

Use only data you are authorized to process and follow applicable laws and
platform terms.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project directory.
5. Open the extension popup and choose **Open dashboard**.
6. Import `sample-prospects.json` to try the dashboard.

No install or build step is required. Records can also be added manually with
**Add prospect**. Use card checkboxes for bulk status updates and exports; use
**History** to review local changes and **JSON backup** for a complete snapshot.

## Import fields

CSV and JSON imports support these fields (snake_case aliases are accepted):

- `username`
- `fullName`
- `biography`
- `profileUrl`
- `postCount`
- `followerCount`
- `followingCount`
- `isPrivate`
- `isVerified`
- `isBusinessAccount`
- `isProfessionalAccount`
- `mutualCount`
- `activityLevel` (`high`, `moderate`, `low`, or `unknown`)
- `sourceUsernames` (JSON array, or semicolon-separated in CSV)
- `status`

The extension stores the data in `chrome.storage.local`. It requests no host
permissions and does not run a content script on Instagram or any other site.

## Tests

Requires Node.js 20 or newer:

```bash
npm test
```

Tests use Node's built-in runner, so no dependency installation is needed.
