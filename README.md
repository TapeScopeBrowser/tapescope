TapeScope
Chrome / Edge Manifest V3 extension. Read-only, local, no backend.
Shows only what Vest reports:
Tape: every print, newest on top: time (ms), price, qty, quoteQty, side, exactly as reported.
Tick stream: bubbles coloured by reported side, plus a step line.
BUBBLE: area ∝ qty on a fixed scale (r = 1.5 + 4·k·√qty px), so the same qty is always the same
size. No percentiles or relative scaling. `uniform` = plain dots.
GROUP `taker order (seq)`: fills sharing Vest's match seq (id `…:<seq>:<n>`) become one bubble at
the qty-weighted price, with a vertical line across the levels swept. Verified: every seq group
has a single timestamp. `each print` = one bubble per fill. Hover for the fill breakdown.
OHLC: candles built directly from prints (5s – 1h), or Vest's own klines as a separate source.
Removed from v0.8 (all were derived/assumed): VWAP + NY session anchoring, buy/sell $ and delta,
time+side "order" grouping, heatmap, volume profile, percentile bubble sizing, MIN filter,
depth-line overlay, IndexedDB persistence, and blending klines with trades.
Affiliate
TapeScope is free and works without using any referral link.
The in-app OPEN VEST button points to:
`https://next.vestmarkets.com/r/wptapescope`
Referral code: `WPTAPESCOPE`
Disclosure: the TapeScope publisher may earn a commission if you create or use a Vest account through that link. The link is only opened after an explicit click; TapeScope does not rewrite Vest URLs or apply referrals in the background.

Install
chrome://extensions → enable Developer mode.
Load unpacked → select the folder containing manifest.json.
Click the toolbar icon to open the page.
Data notes (verified against the live API, 2026-10-09)
`/v2/klines` ignores startTime/endTime and only returns the latest 501 bars per interval
(1m ≈ 8.3h). Its prices are off the 0.25 tick and can differ from the last trade by many points,
so it's a different series (likely index/mark). That's why it's never mixed with trade candles.
There is no websocket kline stream; the klines source is re-polled every 5s.
REST trade ids (`prod:103:<seq>:<n>`) and websocket ids (`<hash>:<seq>:<n>`) differ; prints are
deduplicated on the shared `<seq>:<n>` suffix. Identical price/qty/time prints with different
seqs are real separate fills and are kept.
`/v3/trades` pages backwards by endTime (~1000 prints ≈ 15 min). 24h backfill ≈ 90 requests.
On websocket reconnect, missed prints are filled from REST; failure is reported in the status bar.
Controls
Drag chart = pan time · wheel on chart = change span · drag/wheel price axis = scale ·
double-click price axis = autoscale · double-click chart / LIVE = follow now.
