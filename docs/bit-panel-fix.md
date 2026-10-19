# bIT panel viewport fix

## Reproduction

Reproduced the deployed `bit-os.pages.dev` bug in authenticated Playwright browsers before changing the panel: at both 390×844 and 320×568, its 280px-wide box began at **x = -208px**. The old absolutely positioned popover was right-aligned to a trigger close to the left edge. It also used a fixed dark background instead of the dashboard's theme colors.

Before screenshots and measurements:

- `docs/proof/bit-panel/before-390.png`
- `docs/proof/bit-panel/before-320.png`
- `docs/proof/bit-panel/before.json`

## Change

`BitPanel.tsx` is a reusable dialog shell receiving its avatar, title and scrolling content independently of presence data. It adds no chat feature yet.

- Below 640px: fixed full-width, full-height **100dvh** sheet, safe-area padding on all four sides, and `viewport-fit=cover` in the document viewport metadata. The avatar and close button remain in the header; the body scrolls independently. Opening fixes the page body in place; closing restores the previous styles and page scroll position.
- Desktop: fixed popover positioned near the orb, clamped on all sides to the visual viewport with 12px margins. Size, viewport and scroll changes update its placement; long content is constrained and scrolls inside the body.
- Native modal semantics move focus inside and prevent background interaction. The close button receives initial focus; explicit Tab/Shift-Tab wrapping also handles WebKit's single-control edge case. X and Escape close it; backdrop clicks close it on desktop. Closing returns focus to the orb without scrolling the page.
- Surface/text colors follow the dashboard's light/dark theme.

## Automated proof

`npm run test:browser --prefix apps/dashboard` starts an isolated Vite server and runs Playwright against the real components with 80 deterministic pending approvals. The client module is replaced with an offline fixture: no credentials or hosted data are needed, and no approvals/tasks are written. Playwright is pinned in the isolated `tools/dashboard-browser` package; it is absent from the Pages dashboard dependency tree. Fixtures are not imported by the production entry point.

Install the local test dependencies with `npm ci --prefix tools/dashboard-browser`, then browsers with `npm run install:browsers --prefix tools/dashboard-browser`. Ensure browser OS dependencies are available. Run Chromium with `npm run test:browser --prefix apps/dashboard`, or both engines with `BIT_PANEL_WEBKIT=1 npm run test:browser --prefix apps/dashboard`. `BIT_PANEL_PROOF_DIR` optionally writes screenshots and bounds to an existing directory.

All five browser scenarios passed in **both Chromium and WebKit**, including mobile/touch contexts. They verify:

- Panel bounds and a usable content area at 320, 390, 768 and 1280px.
- Full-height sheets at both mobile sizes; body scroll locking and restoration of pre-existing styles/scroll position.
- Reaching the last of 80 entries by scrolling the panel body.
- Close, Escape and desktop outside-click dismissal; initial focus, focus wrapping and focus restoration.
- Desktop anchors at every corner, plus resizing an open panel across mobile/desktop widths and reduced viewport heights.
- No browser runtime errors.

This host needed additional WebKit libraries. They were downloaded as official Ubuntu packages and extracted into `/tmp` for the test browser; a temporary launcher preserved the library search path. No system packages or cached browser files were modified. The standard test command needs only the usual Playwright browser dependencies on other hosts. `BIT_PANEL_WEBKIT_EXECUTABLE` can optionally select a local launcher.

Measured boxes with long scrolling content (both engines):

| Viewport | Panel |
| --- | --- |
| 320×568 | x=0, y=0, width=320, height=568 |
| 390×844 | x=0, y=0, width=390, height≈844 |
| 768×844 | x≈41.77, y=12, width=320, height=820 |
| 1280×844 | x≈533.30, y=12, width=320, height=820 |

Measurements: `docs/proof/bit-panel/bounds.json`. After screenshots for every width/engine are named `after-chromium-*.png` and `after-webkit-*.png` in that directory. Additional authenticated WebKit screenshots against the fixed local dashboard are `after-live-webkit-390.png` and `after-live-webkit-320.png`, with bounds in `after-live.json`. “Live” here refers to real account data, not a pre-deployment production change. Physical iPhone toolbar behavior is not claimed as observed.

Validation: production build and credential scan passed; all 25 dashboard unit tests passed; all five browser scenarios passed in each of two engines.

Deployment uses the existing Cloudflare Pages Git integration from main. No Wrangler login or direct upload is used. After pushing this fix, verify the Cloudflare Pages check for the new commit and reload `https://bit-os.pages.dev` on the iPhone.
