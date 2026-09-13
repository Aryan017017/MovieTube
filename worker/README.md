# Player Proxy (popup shield)

A Cloudflare Worker that proxies the Videasy player and injects a JS shield to
disable popups, popunders, and top-frame redirects.

## Deploy (free, ~5 min, no credit card)

1. Sign up at https://dash.cloudflare.com/sign-up (free).
2. Install Wrangler:
   ```
   npm install -g wrangler
   ```
3. From this folder:
   ```
   cd worker
   wrangler login
   wrangler deploy
   ```
4. Copy the deployed URL (looks like `https://moviebox-player-proxy.<your-handle>.workers.dev`).
5. Open `app.js` in the project root and set:
   ```js
   const PROXY_PLAYER_BASE = "https://moviebox-player-proxy.<your-handle>.workers.dev";
   ```
   Leave it as `""` (empty) to disable the proxy and use Videasy directly.
6. Commit and push — your live site now routes the player through the proxy.

## Notes

- **Free tier:** 100k requests/day. Each play counts as ~1 main HTML request plus
  some sub-resources (CSS/JS/images cached after first load). You won't hit the
  limit unless your site has thousands of daily users.
- **Fragile:** if Videasy changes the structure of their player, the shield may
  not catch every popup vector. Edit `SHIELD` in `index.js` and redeploy.
- **HLS streams** (the actual video) are NOT proxied — they load directly from
  the CDN. Streams typically don't trigger popups.
- **Legal:** proxying a third-party service is grey-zone. If Videasy blocks
  your Worker IP, the proxy stops working. Don't use this for anything you'd
  cry about losing.
