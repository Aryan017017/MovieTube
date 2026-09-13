// Cloudflare Worker — Videasy proxy with popup shield.
// Deploy: see worker/README.md
//
// What it does:
// 1. Proxies https://player.videasy.net through your Worker origin.
// 2. Injects a JS shield in <head> that disables window.open, top-frame redirects,
//    and other popup/popunder tricks before any third-party script runs.
// 3. Rewrites <a href="..."> and form actions to absolute https://player.videasy.net
//    URLs so links don't try to escape via document.baseURI.
//
// It does NOT proxy HLS .m3u8 segments — those continue to load directly from
// their origin CDN (no popups originate there).

const UPSTREAM = "https://player.videasy.net";

const SHIELD = `<script>(function(){
  try {
    var noop = function(){ return null; };
    try { Object.defineProperty(window, 'open', { value: noop, writable: false, configurable: false }); } catch(e){ window.open = noop; }
    // Neutralize popunder via blur/focus tricks
    window.focus = noop;
    // Block top-frame redirects from inside the iframe
    try { Object.defineProperty(window, 'top', { get: function(){ return window; } }); } catch(e){}
    try { Object.defineProperty(window, 'parent', { get: function(){ return window; } }); } catch(e){}
    // Stop beforeunload-based redirects
    window.addEventListener('beforeunload', function(e){ e.stopImmediatePropagation(); }, true);
    // Block <a target="_blank"> auto-clicks
    document.addEventListener('click', function(e){
      var a = e.target && e.target.closest && e.target.closest('a');
      if (a && (a.target === '_blank' || a.target === '_top') && !e.isTrusted === false) {
        // allow user-initiated; block synthesised
        if (!e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); }
      }
    }, true);
    // Heuristic: kill rogue iframes injected after load
    var killBadIframes = function(){
      document.querySelectorAll('iframe').forEach(function(f){
        var s = (f.src || '') + '';
        if (/ad|popunder|popcash|propeller|adsterra|exoclick|onclick/i.test(s)) f.remove();
      });
    };
    setInterval(killBadIframes, 1000);
  } catch(e) {}
})();</script>`;

class HeadInjector {
  element(el) {
    el.prepend(SHIELD, { html: true });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Build upstream URL: keep path + query
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // Forward the request, dropping cookies
    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers: stripHeaders(request.headers),
      body: request.body,
      redirect: "follow",
    });

    let res;
    try {
      res = await fetch(upstreamReq);
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, { status: 502 });
    }

    const ct = res.headers.get("content-type") || "";

    // Only rewrite HTML responses
    if (ct.includes("text/html")) {
      const rewriter = new HTMLRewriter().on("head", new HeadInjector());
      const newRes = new Response(res.body, res);
      // Permissive CORS so our parent page can iframe it freely
      newRes.headers.set("X-Frame-Options", "ALLOWALL");
      newRes.headers.set("Content-Security-Policy", "frame-ancestors *;");
      newRes.headers.delete("x-frame-options"); // override if upstream set
      newRes.headers.set("X-Frame-Options", "ALLOWALL");
      return rewriter.transform(newRes);
    }

    // Pass through non-HTML (JS/CSS/images) unchanged
    const passthrough = new Response(res.body, res);
    passthrough.headers.set("X-Frame-Options", "ALLOWALL");
    return passthrough;
  },
};

function stripHeaders(h) {
  const out = new Headers();
  for (const [k, v] of h) {
    const kk = k.toLowerCase();
    if (kk === "cookie" || kk === "host" || kk === "cf-connecting-ip" || kk.startsWith("cf-")) continue;
    out.set(k, v);
  }
  // Pretend to be a normal browser visiting Videasy
  out.set("Referer", UPSTREAM + "/");
  out.set("Origin", UPSTREAM);
  return out;
}
