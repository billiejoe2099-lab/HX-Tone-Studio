/**
 * Cloudflare Worker proxy for HX Tone Studio.
 * Required secrets: GEMINI_API_KEY, APP_TOKEN
 * Optional vars: CORS_ORIGIN (comma-separated), GEMINI_MODEL
 */
const DEFAULT_ORIGIN = "https://billiejoe2099-lab.github.io";
const MODEL_FALLBACKS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];

/** @typedef {{ APP_TOKEN: string, GEMINI_API_KEY: string, CORS_ORIGIN?: string, GEMINI_MODEL?: string }} WorkerEnv */

const SYSTEM = `Eres asesor experto de tonos para Line 6 HX Stomp con firmware 3.80. Genera una recomendación práctica para la grabación y el equipo indicados. Responde exclusivamente un objeto JSON válido, sin markdown ni texto fuera del JSON. Esquema: {meta:{song,artist,album,coverUrl,trackId,tuning,tempo,key,notes,guitarId,guitarAdvice},modes:{live:{label,summary,blocks:[{id,type,name,model,icon,enabled,dsp,params:{parametro:valor}}]},pa:{label,summary,blocks:[...]}},snapshots:{live:[{id,name,changes:[{blockId,kind,params?,block?}]}],pa:[...]}}.

Sé honesto. No inventes datos musicales, fuentes, modelos HX o valores exactos; si no tienes información fiable, usa cadena vacía o null y dilo en meta.notes. No hay búsqueda web en esta generación; no afirmes haber investigado. No reproduzcas letras, tablaturas ni el manual.

Reglas: ambos modos comienzan con Input Gate y sus parámetros Threshold y Decay. Live va al FX Return de Crate MX120R y no incluye Cab/IR. Contexto de banda: dos guitarras, bajo, batería, teclado y voces; mezcla conservadora para dejar espacio. PA directo sí incluye amp y cab, además micrófono, posición, distancia, low cut y high cut como parámetros del bloque Cab cuando sean compatibles. Máximo 8 bloques DSP activos por cadena. Si la guitarra está en E estándar pero la canción requiere otra afinación, recomienda Simple Pitch con el cambio requerido y explica límites prácticos. Ajusta al perfil de guitarra y partes solicitadas. Sugiere pastilla/controles en meta.guitarAdvice. Snapshots son cambios relativos al Rhythm: kind='change' incluye solo parámetros alterados, kind='on' incluye el bloque completo, kind='off' apaga el bloque. Incluye snapshots solo para las partes solicitadas.`;

function configuredOrigins(env) {
  return (env.CORS_ORIGIN || DEFAULT_ORIGIN)
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function responseHeaders(origin, allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": origin ? allowedOrigin : DEFAULT_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...responseHeaders(origin, allowedOrigin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function tokenIsValid(request, env) {
  return typeof env.APP_TOKEN === "string" && env.APP_TOKEN.length > 0 &&
    request.headers.get("X-App-Token") === env.APP_TOKEN;
}

function isDailyQuotaError(message) {
  const text = typeof message === "string" ? message : JSON.stringify(message || {});
  return /daily|per[_\s-]?day|requests_per_day|tokens_per_day|quota.{0,80}(daily|per.day)/i.test(text);
}

async function askGemini(model, body, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body,
  });
  /** @type {any} */
  const data = await upstream.json().catch(() => ({}));
  return { upstream, data };
}

export default {
  /** @param {Request} request @param {WorkerEnv} env */
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    const origins = configuredOrigins(env);
    const origin = requestOrigin.replace(/\/$/, "");
    const allowed = !origin || origins.includes(origin);
    const allowedOrigin = origin && origins.includes(origin) ? origin : (origins[0] || DEFAULT_ORIGIN);

    if (!allowed) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders(origin, allowedOrigin) });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      if (!tokenIsValid(request, env)) return json({ error: "Token incorrecto o no configurado." }, 401, origin, allowedOrigin);
      return json({ ok: true, model: env.GEMINI_MODEL || MODEL_FALLBACKS[0] }, 200, origin, allowedOrigin);
    }

    if (!tokenIsValid(request, env)) return json({ error: "Token incorrecto o no configurado." }, 401, origin, allowedOrigin);
    if (request.method === "GET" && url.pathname.endsWith("/search")) {
      const term = (url.searchParams.get("term") || "").trim();
      if (term.length < 2) return json({ results: [] }, 200, origin, allowedOrigin);
      try {
        const catalogUrl = new URL("https://itunes.apple.com/search");
        catalogUrl.search = new URLSearchParams({ media: "music", entity: "song", limit: "14", country: "MX", term }).toString();
        const catalogResponse = await fetch(catalogUrl.toString(), { headers: { Accept: "application/json" } });
        if (!catalogResponse.ok) return json({ error: `Apple Search respondió ${catalogResponse.status}.` }, 502, origin, allowedOrigin);
        const catalog = await catalogResponse.json();
        return json({ results: catalog.results || [] }, 200, origin, allowedOrigin);
      } catch (error) {
        return json({ error: `No se pudo consultar Apple Search: ${error.message || "error de red"}` }, 502, origin, allowedOrigin);
      }
    }

    if (request.method !== "POST") return json({ error: "Usa POST para generar una recomendación." }, 405, origin, allowedOrigin);
    if (!env.GEMINI_API_KEY) return json({ error: "Falta GEMINI_API_KEY en los secretos del Worker." }, 500, origin, allowedOrigin);

    /** @type {any} */
    let requestData;
    try {
      requestData = await request.json();
    } catch {
      return json({ error: "El cuerpo de la solicitud no es JSON válido." }, 400, origin, allowedOrigin);
    }
    if (!requestData || typeof requestData !== "object" || Array.isArray(requestData)) {
      return json({ error: "El cuerpo JSON debe ser un objeto con canción, guitarra y partes." }, 400, origin, allowedOrigin);
    }

    const input = {
      track: requestData.track || {},
      guitar: requestData.guitar || {},
      requestedParts: requestData.parts || {},
      firmware: requestData.firmware || "HX Stomp 3.80",
      rig: requestData.rig || {},
    };
    const preferred = (env.GEMINI_MODEL || MODEL_FALLBACKS[0]).trim().replace(/^models\//, "");
    const models = [...new Set([preferred, ...MODEL_FALLBACKS])];
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.35, maxOutputTokens: 7000 },
    });

    let lastStatus = 503;
    let lastMessage = "Gemini está temporalmente saturado.";
    let attempted = [];
    let quotaExhausted = false;
    for (const model of models) {
      attempted.push(model);
      for (let attempt = 0; attempt < 2; attempt++) {
        let result;
        try {
          result = await askGemini(model, body, env.GEMINI_API_KEY);
        } catch (error) {
          lastStatus = 502;
          lastMessage = error.name === "TimeoutError" ? "La solicitud a Gemini excedió 25 segundos." : (error.message || "Error de red con Gemini.");
          break;
        }

        const { upstream, data } = result;
        if (upstream.ok) {
          const answerText = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
          if (!answerText) return json({ error: data.promptFeedback?.blockReason || `Gemini (${model}) no devolvió contenido.` }, 502, origin, allowedOrigin);
          try {
            return json({ preset: JSON.parse(answerText), model }, 200, origin, allowedOrigin);
          } catch {
            return json({ error: `Gemini (${model}) no devolvió JSON válido. Prueba otra vez.` }, 502, origin, allowedOrigin);
          }
        }

        lastStatus = upstream.status;
        lastMessage = data.error?.message || `Gemini respondió ${upstream.status}.`;
        if (upstream.status === 401 || upstream.status === 403) {
          return json({ error: `Google rechazó GEMINI_API_KEY: ${lastMessage}` }, 502, origin, allowedOrigin);
        }
        if (upstream.status === 429 && isDailyQuotaError(data.error)) {
          quotaExhausted = true;
          break;
        }

        const retryable = upstream.status === 408 || upstream.status === 429 || upstream.status === 503 || upstream.status >= 500;
        const modelUnavailable = upstream.status === 404;
        if (!retryable && !modelUnavailable) return json({ error: `${model}: ${lastMessage}` }, upstream.status, origin, allowedOrigin);
        if (attempt === 0 && retryable) await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 450));
        else break;
      }
      if (quotaExhausted) break;
    }

    const quotaNote = quotaExhausted
      ? " La cuota diaria del proyecto parece agotada; cambiar de modelo no la restablece."
      : "";
    return json({
      error: `No se pudo generar el preset. Modelos intentados: ${attempted.join(", ")}. ${lastMessage}${quotaNote} Puedes cambiar a ChatGPT manual desde la app.`,
    }, lastStatus >= 400 && lastStatus <= 599 ? lastStatus : 503, origin, allowedOrigin);
  },
};
