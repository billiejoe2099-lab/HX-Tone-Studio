/**
 * Gemini free-tier proxy for HX Tone Studio.
 * Cloudflare Worker free plan + a Gemini API key from Google AI Studio.
 * Configure GEMINI_API_KEY, APP_TOKEN, and CORS_ORIGIN as Worker secrets/vars.
 */
const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function getOrigin(request, env) {
  const origin = request.headers.get("Origin") || "null";
  const allowed = (env.CORS_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean);
  return { origin, allowed: allowed.includes(origin) };
}

function hasValidToken(request, env) {
  return Boolean(env.APP_TOKEN) && request.headers.get("X-App-Token") === env.APP_TOKEN;
}

const SYSTEM = `Eres asesor de tonos y presets para Line 6 HX Stomp, firmware 3.80. Devuelve SOLO un objeto JSON, sin markdown, con esta forma: {meta:{song,artist,album,coverUrl,trackId,tuning,tempo,key,notes,guitarId},modes:{live:{label,summary,blocks:[{id,type,name,model,icon,enabled,dsp,params:{nombreParametro:valor}}]},pa:{label,summary,blocks:[...]}},snapshots:{live:[{id,name,changes:[{blockId,kind,params?,block?}]}],pa:[...]}}.

Sé honesto: no inventes fuentes, modelo HX ni valores exactos. No hay búsqueda web en esta generación gratuita; usa solo conocimientos previos y los metadatos entregados. Si la afinación, tonalidad o tempo no te constan con fiabilidad, devuelve cadena vacía o null y explica la incertidumbre en meta.notes. Recomienda verificar manualmente antes de tocar. No reproduzcas letras, tablaturas ni el manual.

Reglas del preset: comienza cada modo con Input Gate (threshold y decay), nunca más de 8 bloques por cadena. Live para FX Return de Crate MX120R, sin Cab/IR, banda de 2 guitarras, bajo, batería, teclado y voz; mezcla conservadora. PA directo: incluye amp y cab con micrófono, posición, distancia, low cut y high cut usando nombres compatibles con HX Stomp 3.80. Si la guitarra está en E estándar y la canción requiere Eb, añade Simple Pitch con -1 semitono, dejando clara la limitación. Ajusta cadena al perfil de guitarra y a las partes solicitadas. Sugiere pickup/controles en meta.guitarAdvice o meta.notes. Snapshots son cambios respecto a Rhythm: kind='change' con solo parámetros alterados, kind='on' con block completo, kind='off' para apagar; crea solo los solicitados (lead y clean solo si fueron marcados). Incluye ambos modos.`;

export default {
  async fetch(request, env) {
    const { origin, allowed } = getOrigin(request, env);
    if (!allowed) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      if (!hasValidToken(request, env)) return json({ error: "Token incorrecto o no configurado." }, 401, origin);
      return json({ ok: true, model: env.GEMINI_MODEL || "gemini-3.8-flash" }, 200, origin);
    }
    if (!hasValidToken(request, env)) return json({ error: "Token incorrecto o no configurado." }, 401, origin);
    if (request.method === "GET" && url.pathname.endsWith("/search")) {
      const term = (url.searchParams.get("term") || "").trim();
      if (term.length < 2) return json({ results: [] }, 200, origin);
      try {
        const catalogUrl = new URL("https://itunes.apple.com/search");
        catalogUrl.search = new URLSearchParams({ media: "music", entity: "song", limit: "14", country: "MX", term }).toString();
        const catalogResponse = await fetch(catalogUrl.toString(), { headers: { "Accept": "application/json" } });
        if (!catalogResponse.ok) return json({ error: `Apple Search respondió ${catalogResponse.status}.` }, 502, origin);
        const catalog = await catalogResponse.json();
        return json({ results: catalog.results || [] }, 200, origin);
      } catch (error) {
        return json({ error: "No se pudo consultar Apple Search: " + error.message }, 502, origin);
      }
    }
    if (request.method !== "POST") return json({ error: "Usa POST para generar una recomendación." }, 405, origin);
    if (!env.GEMINI_API_KEY) return json({ error: "Falta configurar GEMINI_API_KEY como secreto en el Worker." }, 500, origin);

    let requestData;
    try { requestData = await request.json(); }
    catch { return json({ error: "El cuerpo de la solicitud no es JSON válido." }, 400, origin); }

    const input = {
      track: requestData.track || {},
      guitar: requestData.guitar || {},
      requestedParts: requestData.parts || {},
      firmware: requestData.firmware || "HX Stomp 3.80",
      rig: requestData.rig || {},
    };
    try {
      const model = env.GEMINI_MODEL || "gemini-3.8-flash";
      const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.35, maxOutputTokens: 7000 },
        }),
      });
      const result = await upstream.json();
      if (!upstream.ok) return json({ error: result.error?.message || `Gemini respondió ${upstream.status}. Revisa el modelo y la cuota gratis.` }, upstream.status, origin);
      const text = result.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!text) return json({ error: result.promptFeedback?.blockReason || "Gemini no devolvió texto. Revisa límites o filtros de seguridad." }, 502, origin);
      let preset;
      try { preset = JSON.parse(text); }
      catch { return json({ error: "Gemini no devolvió JSON válido. Vuelve a intentarlo." }, 502, origin); }
      return json({ preset, model }, 200, origin);
    } catch (error) {
      return json({ error: "No se pudo contactar Gemini: " + error.message }, 502, origin);
    }
  },
};
