TapeScope
=========

Chrome / Edge Manifest V3 extension. Read-only, local, no backend.

Shows only what Vest reports:
- **Tape**: every print, newest on top: time (ms), price, qty, quoteQty, side, exactly as reported.
- **Tick stream**: bubbles coloured by reported side, plus a step line.
- **OHLC**: candles built directly from prints (5s – 1h), or Vest's own klines as a separate source.


Affiliate
---------
TapeScope is free and works without using any referral link.

The in-app **OPEN VEST** button points to:
`https://next.vestmarkets.com/r/wptapescope`

Referral code: `WPTAPESCOPE`

Disclosure: the TapeScope publisher may earn a commission if you create or use a Vest account through that link. The link is only opened after an explicit click; TapeScope does not rewrite Vest URLs or apply referrals in the background.


Install
-------
1. chrome://extensions → enable Developer mode.
2. Load unpacked → select the folder containing manifest.json.
3. Click the toolbar icon to open the page.


Controls
--------
Drag chart = pan time · wheel on chart = change span · drag/wheel price axis = scale ·
double-click price axis = autoscale · double-click chart / LIVE = follow now.
