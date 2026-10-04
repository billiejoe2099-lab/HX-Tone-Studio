/**
 * Personal AI proxy for HX Tone Studio.
 * Configure OPENAI_API_KEY, APP_TOKEN, and CORS_ORIGIN as Worker secrets/vars.
 * Never put the OpenAI API key in the HTML bundle.
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

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "null";
  const allowed = (env.CORS_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean);
  return { origin, allowed: allowed.includes(origin) };
}

function tokenValid(request, env) {
  const expected = env.APP_TOKEN || "";
  return expected.length > 0 && request.headers.get("X-App-Token") === expected;
}

export default {
  async fetch(request, env) {
    const { origin, allowed } = allowedOrigin(request, env);
    if (!allowed) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!tokenValid(request, env)) return json({ error: "Token incorrecto o no configurado." }, 401, origin);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/health")) return json({ ok: true }, 200, origin);
    if (request.method !== "POST") return json({ error: "Usa POST para generar una recomendación." }, 405, origin);
    if (!env.OPENAI_API_KEY) return json({ error: "Falta configurar OPENAI_API_KEY en el Worker." }, 500, origin);

    let requestData;
    try {
      requestData = await request.json();
    } catch {
      return json({ error: "El cuerpo de la solicitud no es JSON válido." }, 400, origin);
    }

    const system = `Eres un asesor de tonos para Line 6 HX Stomp. Investiga la versión exacta de la canción con búsqueda web cuando esté disponible; diferencia grabación de estudio, en vivo y remaster. Entrega exclusivamente JSON válido para un visor, no un preset .hlx. No reproduzcas el manual ni letras/tabulaturas protegidas. Usa nombres HX reales de firmware 3.80 y nombres de parámetros solo si estás seguro; si no, marca incertidumbre en meta.notes y no presentes conjeturas como datos confirmados. Incluye información breve de fuentes consultadas en meta.notes. La afinación, tonalidad y BPM deben corresponder a la versión seleccionada; si no hay evidencia suficiente, usa cadena vacía o null y dilo en notes. Considera el perfil de guitarra, mods y las partes solicitadas.

Devuelve objeto con este esquema aproximado: {meta:{song,artist,album,coverUrl,trackId,tuning,tempo,key,notes,guitarId},modes:{live:{label,summary,blocks:[{id,type,name,model,icon,enabled,dsp,params:{nombreParametro:valor}}]},pa:{label,summary,blocks:[...]}},snapshots:{live:[{id,name,changes:[{blockId,kind,params?,block?}]}],pa:[...]}}.

Reglas de mezcla y preset: empieza cada cadena con Input Gate (threshold y decay), luego bloques de sonido; no excedas 8 bloques DSP simultáneos por variante. Si la guitarra permanece en E estándar y la canción va afinada medio tono abajo, incluye Simple Pitch -1 semitone con calidad/limitación señalada. Live: FX Return de Crate MX120R, sin Cab/IR, en banda con dos guitarras, bajo, batería, teclado y voz; evita competir con voz y bajo y ajusta niveles conservadoramente. PA: incluye amp/cab, mic, posición, distancia, low cut y high cut solo con nombres/valores realmente disponibles. Snapshots solo contienen diferencias relativas a Rhythm: kind change con solo params que cambian; kind on con objeto block completo; kind off para apagar. Crea solo los snapshots necesarios para las partes marcadas; clean únicamente si fue solicitado. Recomienda posición de pastilla y controles guitarra en meta.guitarAdvice o meta.notes. Incluye ambos modos aunque una ruta sea imposible de recomendar con certeza.`;

    const input = {
      track: requestData.track || {},
      guitar: requestData.guitar || {},
      requestedParts: requestData.parts || {},
      firmware: requestData.firmware || "HX Stomp 3.80",
      rig: requestData.rig || {},
    };

    try {
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.OPENAI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.4-mini",
          store: false,
          tools: [{ type: "web_search" }],
          reasoning: { effort: "low" },
          max_output_tokens: 7000,
          text: { format: { type: "json_object" } },
          input: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
      });
      const result = await upstream.json();
      if (!upstream.ok) return json({ error: result.error?.message || "OpenAI API rechazó la solicitud." }, upstream.status, origin);
      const text = result.output_text || (result.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("\n");
      if (!text) return json({ error: "La respuesta no incluyó el JSON del preset." }, 502, origin);
      let preset;
      try {
        preset = JSON.parse(text);
      } catch {
        return json({ error: "La respuesta IA no pudo interpretarse como JSON." }, 502, origin);
      }
      return json({ preset }, 200, origin);
    } catch (error) {
      return json({ error: "No se pudo contactar la API de OpenAI: " + error.message }, 502, origin);
    }
  },
};
