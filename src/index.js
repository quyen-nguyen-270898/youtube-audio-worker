export default {
  async fetch(request) {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) {
      return new Response("Missing q param", { status: 400 });
    }

    // 1. Search YouTube
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    const searchHtml = await searchRes.text();

    // 2. Extract first videoId
    const match = searchHtml.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!match) {
      return new Response("No video found", { status: 404 });
    }
    const videoId = match[1];

    // 3. Get player JSON
    const playerRes = await fetch("https://www.youtube.com/youtubei/v1/player?key=AIzaSyA-EDo41e_gqYJgXLEh9gJaW16PDp5D6eY", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240214.01.00"
          }
        },
        videoId: videoId
      })
    });

    let json = await playerRes.json();

    let streamer = json.streamingData || {};
    let formats = [
      ...(streamer.formats || []),
      ...(streamer.adaptiveFormats || [])
    ];

    // If streamingData is empty, try fallback: fetch watch page and parse ytInitialPlayerResponse
    let fallbackUsed = false;
    if (!formats.length) {
      try {
        const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const watchHtml = await watchRes.text();

        const m = watchHtml.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (m && m[1]) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed && parsed.streamingData) {
              json = parsed;
              streamer = parsed.streamingData;
              formats = [
                ...(streamer.formats || []),
                ...(streamer.adaptiveFormats || [])
              ];
              fallbackUsed = true;
            }
          } catch (e) {
            // ignore JSON parse errors
          }
        }
      } catch (e) {
        // ignore network errors for fallback
      }
    }

    // inspect formats for signatureCipher objects and try to surface player JS URL
    let playerJsUrl = null;
    try {
      // if we have watchHtml from above, try to find player JS path
      if (typeof watchHtml === 'string') {
        const mjs = watchHtml.match(/(\/s\/player\/[\w\d_\-/.]+base\.js)/);
        if (mjs && mjs[1]) playerJsUrl = `https://www.youtube.com${mjs[1]}`;
      } else {
        // fallback: fetch watch page to find player js when necessary
        const w2 = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const h2 = await w2.text();
        const mjs2 = h2.match(/(\/s\/player\/[\w\d_\-/.]+base\.js)/);
        if (mjs2 && mjs2[1]) playerJsUrl = `https://www.youtube.com${mjs2[1]}`;
      }
    } catch (e) {
      // ignore
    }

    // helper: fetch player JS and try to extract decipher operations
    async function fetchPlayerAndGetOps(url) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const js = await res.text();

        // 1) find the name of the decipher function
        let nameMatch = js.match(/([a-zA-Z0-9$]{2,})\s*=\s*function\s*\(a\)\s*\{\s*a\s*=\s*a\.split\(""\)/);
        if (!nameMatch) nameMatch = js.match(/function\s+([a-zA-Z0-9$]{2,})\s*\(a\)\s*\{\s*a\s*=\s*a\.split\(""\)/);
        if (!nameMatch) return null;
        const fnName = nameMatch[1];

        // 2) extract the function body
        const fnBodyRegex = new RegExp(fnName + '\\s*=\\s*function\\(a\\)\\s*\\{([\\s\\S]*?)\\}');
        let fnBodyMatch = js.match(fnBodyRegex);
        if (!fnBodyMatch) {
          const fnBodyRegex2 = new RegExp('function\\s+' + fnName + '\\(a\\)\\s*\\{([\\s\\S]*?)\\}');
          fnBodyMatch = js.match(fnBodyRegex2);
        }
        if (!fnBodyMatch) return null;
        const fnBody = fnBodyMatch[1];

        // 3) detect helper object name used like AB.cd(a, 3)
        const objNameMatch = fnBody.match(/([A-Za-z0-9_$]{2,})\.[A-Za-z0-9_$]{2,}\(a,\d+\)/);
        const objName = objNameMatch ? objNameMatch[1] : null;

        // 4) extract helper object source if present
        let helperSrc = '';
        if (objName) {
          const helperRegex = new RegExp('var\\s+' + objName + '\\s*=\\s*\\{([\\s\\S]*?)\\};');
          const h = js.match(helperRegex) || js.match(new RegExp('const\\s+' + objName + '\\s*=\\s*\\{([\\s\\S]*?)\\};')) || js.match(new RegExp('let\\s+' + objName + '\\s*=\\s*\\{([\\s\\S]*?)\\};'));
          helperSrc = h ? h[1] : '';
        }

        // 5) build method map from helperSrc
        const methodMap = {};
        if (helperSrc) {
          // find method definitions like foo: function(a,b){...}
          const methodRegex = /([A-Za-z0-9_$]{2,})\s*:\s*function\s*\([a-z,]+\)\s*\{([\s\S]*?)\}/g;
          let mm;
          while ((mm = methodRegex.exec(helperSrc)) !== null) {
            const mname = mm[1];
            const mbody = mm[2];
            if (/reverse\(\)|\.reverse\(\)/.test(mbody)) methodMap[mname] = 'reverse';
            else if (/splice\(0,\d+\)|splice\(0,e\)/.test(mbody) || /slice\(\d+\)/.test(mbody)) methodMap[mname] = 'slice';
            else methodMap[mname] = 'swap';
          }
        }

        // 6) parse the sequence of operations in fnBody
        const ops = [];

        // direct reverse
        if (/\.reverse\(\)/.test(fnBody)) ops.push({ op: 'reverse' });

        // find calls like obj.method(a, N)
        const callRegex = new RegExp((objName ? objName : '([A-Za-z0-9_$]{2,})') + '\\.([A-Za-z0-9_$]{2,})\\(a,(\\d+)\\)', 'g');
        let cm;
        while ((cm = callRegex.exec(fnBody)) !== null) {
          const method = cm[2];
          const val = parseInt(cm[3], 10);
          const mapped = methodMap[method];
          if (mapped === 'reverse') ops.push({ op: 'reverse' });
          else if (mapped === 'slice') ops.push({ op: 'slice', value: val });
          else ops.push({ op: 'swap', value: val });
        }

        return ops.length ? ops : null;
      } catch (e) {
        return null;
      }
    }

    function applyOps(s, ops) {
      try {
        let a = s.split('');
        for (const o of ops) {
          if (o.op === 'reverse') a = a.reverse();
          else if (o.op === 'slice') a = a.slice(o.value);
          else if (o.op === 'swap') {
            const i = o.value % a.length;
            const tmp = a[0];
            a[0] = a[i];
            a[i] = tmp;
          }
        }
        return a.join('');
      } catch (e) { return s; }
    }

    // if any format has cipher.s and we have a playerJsUrl, try to compute url
    let decipherOps = null;
    if (playerJsUrl) {
      decipherOps = await fetchPlayerAndGetOps(playerJsUrl);
    }

    // augment formats with computedUrl when possible
    for (const f of formats) {
      const sc = f.signatureCipher || f.cipher;
      if (!f.url && sc) {
        let scObj = null;
        if (typeof sc === 'string') {
          try { scObj = Object.fromEntries(new URLSearchParams(sc)); } catch (e) { scObj = null; }
        } else if (typeof sc === 'object') scObj = sc;

        if (scObj && scObj.s) {
          if (decipherOps) {
            const sig = applyOps(scObj.s, decipherOps);
            const sp = scObj.sp || 'sig';
            f.url = scObj.url + '&' + sp + '=' + encodeURIComponent(sig);
            f._deciphered = true;
          } else {
            f._needsDecipher = true;
          }
        }
      }
    }

    function urlFromFormat(f) {
      if (!f) return null;
      if (f.url) return f.url;
      const sc = f.signatureCipher || f.cipher;
      if (typeof sc === 'string') {
        try {
          const params = new URLSearchParams(sc);
          return params.get('url');
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    const audio = formats.find(f => {
      const mt = f.mimeType || '';
      if (!mt.includes('audio')) return false;
      return !!urlFromFormat(f);
    });

    if (!audio) {
      // build diagnostic payload to help debugging
      const available = formats.map(f => {
        const sc = f.signatureCipher || f.cipher;
        let scObj = null;
        if (typeof sc === 'string') {
          try { scObj = Object.fromEntries(new URLSearchParams(sc)); } catch (e) { scObj = null; }
        } else if (sc && typeof sc === 'object') {
          scObj = sc;
        }
        return ({
          mimeType: f.mimeType,
          hasUrl: !!f.url,
          hasCipher: !!sc,
          cipher: scObj ? { url: scObj.url, s: scObj.s, sp: scObj.sp } : null
        });
      });

      return new Response(JSON.stringify({
        error: 'No audio stream found',
        videoId,
        title: json.videoDetails?.title,
        fallbackUsed,
        playerJsUrl,
        availableFormats: available
      }, null, 2), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const audioUrl = urlFromFormat(audio);

    return new Response(JSON.stringify({
      videoId,
      title: json.videoDetails?.title,
      url: audioUrl
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
}
