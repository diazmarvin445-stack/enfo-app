const admin = require("firebase-admin");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const cors = require("cors")({ origin: true });

if (!admin.apps.length) {
  admin.initializeApp();
}

const openaiApiKey = defineSecret("OPENAI_API_KEY");

/** Prompt corto = menos tokens y menor latencia. */
const SYSTEM_PROMPT = `
Eres Tito (ENFO). Español. Coach directo, humano, sin agresividad ni insultos.
Responde en 1–2 párrafos cortos. Sin títulos, viñetas ni etiquetas tipo "Detecto la raíz" / "Corrijo…". No expliques tu proceso.
Ve al punto: problema real, desafía excusas si aplica, perspectiva fuerte, y si hay problema cierra con acción o decisión concreta.
Saludos casuales: respuesta breve sin mandar órdenes.
`.trim();

/** Bloque Deseo (parte de coachMemory fijo en servidor; ver COACH_MEMORY_FIXED_BLOCKS). */
const ENFO_BASE_COACH_MEMORY_TEXT = `
BASE PRIVADA ENFO — DESEO ARDIENTE

1. Un deseo débil produce acciones débiles.
2. Un deseo definido empuja a tomar decisiones.
3. Cuando una persona sabe exactamente qué quiere, reduce la confusión.
4. El deseo debe convertirse en objetivo claro, no en emoción suelta.
5. Querer algo no basta; hay que respaldarlo con acción diaria.
6. La mente se fortalece cuando recuerda con frecuencia su meta principal.
7. El deseo útil no es fantasía: es dirección con compromiso.
8. La duda debilita la ejecución; la claridad la fortalece.
9. La disciplina mantiene vivo el deseo cuando las emociones bajan.
10. Si el objetivo no está definido, la energía se dispersa.
11. El progreso empieza cuando el deseo se traduce en un paso concreto.
12. La repetición mental de una meta ayuda a mantener enfoque.
13. El deseo real obliga a priorizar.
14. Una meta fuerte debe mover conducta, no solo pensamiento.
15. Cuando haya confusión, volver a la pregunta: ¿qué quiero exactamente?
16. Cuando haya miedo o desorden, reducir todo al siguiente paso simple.
17. El deseo debe empujar a actuar hoy, no solo a imaginar.
18. La claridad, la decisión y la acción sostienen el deseo.
`.trim();

const ENFO_CLARIDAD_COACH_MEMORY_TEXT = `
BASE PRIVADA ENFO — CLARIDAD

1. La confusión se reduce definiendo exactamente qué se quiere.
2. Si el objetivo no está claro, la acción se debilita.
3. Pensar demasiado sin definir el problema genera ruido mental.
4. La claridad viene cuando se nombra la prioridad real.
5. No se puede avanzar en todo al mismo tiempo.
6. Una mente enfocada elige una sola dirección.
7. Antes de actuar, preguntar: ¿qué quiero lograr exactamente?
8. Si algo no está claro, dividirlo en partes pequeñas.
9. La claridad elimina duda innecesaria.
10. Una buena decisión empieza con un objetivo definido.
11. Cuando haya desorden mental, volver a una sola prioridad.
12. Lo que no aporta a la prioridad principal debe esperar.
13. La claridad convierte intención en dirección.
14. Si no sabes qué hacer, define primero el resultado que buscas.
15. No confundas actividad con avance.
16. La prioridad correcta simplifica las decisiones.
17. La mente se ordena cuando deja de perseguir todo al mismo tiempo.
18. Claridad, dirección y acción van juntas.
`.trim();

const ENFO_DECISION_COACH_MEMORY_TEXT = `
BASE PRIVADA ENFO — DECISIÓN
`.trim();

const ENFO_ESTRUCTURA_MENTAL_COACH_MEMORY_TEXT = `
BASE PRIVADA ENFO — ESTRUCTURA MENTAL
`.trim();

/** Siempre los mismos cuatro bloques (legacy; ya no se envían enteros al modelo — demasiado tokens). */
const COACH_MEMORY_FIXED_BLOCKS = Object.freeze([
  {text: ENFO_BASE_COACH_MEMORY_TEXT},
  {text: ENFO_CLARIDAD_COACH_MEMORY_TEXT},
  {text: ENFO_DECISION_COACH_MEMORY_TEXT},
  {text: ENFO_ESTRUCTURA_MENTAL_COACH_MEMORY_TEXT}
]);

/** Marco mínimo enviado en cada request (latencia). */
const COACH_MEMORY_INPUT_BLOCKS = Object.freeze([
  {
    text: "Marco ENFO: meta clara → decisión → acción ejecutable. Sin dilación; siguiente paso concreto hoy."
  }
]);

const TITO_CORE_FIELD_LABELS = {
  name: "Nombre / rol",
  creator_context: "Contexto del creador",
  purpose: "Propósito",
  mission: "Misión",
  identity: "Identidad",
  style_rules: "Reglas de estilo y tono",
  response_structure: "Estructura de respuesta",
  core_principles: "Principios centrales",
  non_negotiables: "No negociables",
  forbidden_patterns: "Patrones prohibidos"
};

/** Cache en memoria del cerebro Tito (Firestore) para no leer en cada mensaje. */
let _titoCoreCache = { ts: 0, val: null };
const TITO_CORE_CACHE_MS = 10 * 60 * 1000;

function normalizeTitoField(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const joined = value
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join("\n");
    return joined || undefined;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return undefined;
    }
  }
  const s = String(value).trim();
  return s || undefined;
}

/**
 * Lee cerebro base Tito: tito_brain/core. Devuelve null si falla, no existe o no hay campos útiles.
 */
async function getTitoCoreFromFirestore() {
  const now = Date.now();
  if (now - _titoCoreCache.ts < TITO_CORE_CACHE_MS && _titoCoreCache.ts > 0) {
    return _titoCoreCache.val;
  }
  try {
    const snap = await admin.firestore().collection("tito_brain").doc("core").get();
    if (!snap.exists) {
      console.log("[tito] core: documento ausente");
      _titoCoreCache = { ts: Date.now(), val: null };
      return null;
    }
    const d = snap.data() || {};
    const out = {};
    Object.keys(TITO_CORE_FIELD_LABELS).forEach((key) => {
      const v = normalizeTitoField(d[key]);
      if (v !== undefined) out[key] = v;
    });
    if (Object.keys(out).length === 0) {
      console.log("[tito] core: sin campos reconocidos");
      _titoCoreCache = { ts: Date.now(), val: null };
      return null;
    }
    _titoCoreCache = { ts: Date.now(), val: out };
    return out;
  } catch (err) {
    console.error("[tito] getTitoCoreFromFirestore:", err && err.message ? err.message : err);
    _titoCoreCache = { ts: Date.now(), val: null };
    return null;
  }
}

const TITO_MOD_ANCHORS = {
  mentalidad:
    "MÓDULO ACTIVO ENFO: Mentalidad. Habla SOLO de claridad, disciplina, enfoque, miedo, ejecución mental, pensamiento y dirección. NO menciones clientes, ventas, prospección, CRM, setup de trading, strike/spread, ni hábitos físicos (gimnasio).",
  diario:
    "MÓDULO ACTIVO ENFO: Diario. Solo reflexión escrita, jornada, orden mental y lo que el usuario registró. NO operativa de mercado: sin setups, stops, strikes, spreads, calls/puts ni backtesting salvo que el usuario lo pida para salir de Diario.",
  negocio:
    "MÓDULO ACTIVO ENFO: Negocio. Puedes hablar de clientes, ventas, propuesta, seguimiento, oferta y ejecución comercial. Evita jerga fina de trading (stop, strike, spread) salvo analogía de una frase.",
  trading:
    "MÓDULO ACTIVO ENFO: Trading. Habla SOLO de estrategia operativa, reglas, setup, ejecución, impulsividad, validación/backtesting, riesgo y disciplina operativa. NO menciones clientes, ventas, prospección, pipeline ni negocio comercial.",
  habitos:
    "MÓDULO ACTIVO ENFO: Hábitos. Rutina, consistencia, disciplina diaria, cumplimiento y repetición. Evita ventas, clientes y jerga de trading.",
  general:
    "Módulo general ENFO. Sé breve y útil; no mezcles ventas, trading y rutina en el mismo párrafo sin necesidad."
};

const TITO_MOD_FALLBACK_SRV = {
  mentalidad:
    "En Mentalidad el tema es claridad y dirección. ¿Qué decisión pequeña puedes tomar ya para avanzar sin dispersarte?",
  diario:
    "En Diario trabajamos lo que escribiste y tu jornada. ¿Qué aprendizaje concreto te deja esto, en una sola línea?",
  negocio: "Centra la conversación en oferta, seguimiento y cierre. ¿Cuál es la siguiente acción comercial concreta?",
  trading:
    "En Trading el foco es tu sistema: reglas, riesgo y ejecución sin improvisar. ¿Qué parte de tu plan vas a honrar en la próxima operación?",
  habitos: "La constancia se entrena con repetición. ¿Qué bloque de tu rutina vas a cerrar hoy?",
  general: "Elige un solo paso claro y ejecutable en los próximos minutos."
};

const TITO_MOD_FORBIDDEN_SRV = {
  mentalidad: [
    /\b(clientes?|ventas?|prospecci[oó]n|prospectos?|pipeline|crm)\b/i,
    /\b(setup\s+operativo|backtesting|stop\s*loss|spread\b|strike\b|mercado\s+ahora)\b/i,
    /\b(gimnasio|pesas?\b|cardio\b)\b/i
  ],
  diario: [
    /\b(trading|trade|mercado|setup|backtesting|stop\s*loss|strike|spread|call|put|operativa)\b/i
  ],
  negocio: [/\b(stop\s*loss|backtesting|strike|spread|put\s+spread)\b/i],
  trading: [
    /\b(clientes?|ventas?|prospecci[oó]n|propuesta\s+comercial|pipeline|crm|facturaci[oó]n)\b/i,
    /\b(prospectar|prospecto)\b/i
  ],
  habitos: [
    /\b(clientes?|ventas?|prospecci[oó]n|propuesta\s+comercial)\b/i,
    /\b(backtesting|stop\s*loss|strike|spread)\b/i
  ],
  general: []
};

function sanitizeTitoReplyByModule(text, contextoModulo) {
  if (text == null || typeof text !== "string") return "";
  let t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  const rawMod = contextoModulo && contextoModulo.moduloActivo;
  const mod = ["mentalidad", "diario", "negocio", "trading", "habitos", "general"].includes(rawMod)
    ? rawMod
    : "general";
  const list = TITO_MOD_FORBIDDEN_SRV[mod] || [];
  if (!list.length) return t;

  function cleanBlock(block) {
    const sentences = block.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (let s = 0; s < sentences.length; s++) {
      const sent = sentences[s].trim();
      if (!sent) continue;
      let bad = false;
      for (let i = 0; i < list.length; i++) {
        list[i].lastIndex = 0;
        if (list[i].test(sent)) {
          bad = true;
          break;
        }
      }
      if (!bad) kept.push(sent);
    }
    return kept.join(" ").trim();
  }

  const paras = t
    .split(/\n+/)
    .map(cleanBlock)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (paras.length >= 12) return paras;
  return TITO_MOD_FALLBACK_SRV[mod] || TITO_MOD_FALLBACK_SRV.general;
}

/**
 * Construye instructions para OpenAI desde Firestore; si titoCore es null o vacío, usa SYSTEM_PROMPT.
 */
function buildTitoSystemPrompt(titoCore, contextoModulo) {
  let base;
  if (!titoCore || typeof titoCore !== "object") {
    base = SYSTEM_PROMPT;
  } else {
    const parts = [];
    Object.keys(TITO_CORE_FIELD_LABELS).forEach((key) => {
      const text = titoCore[key];
      if (typeof text === "string" && text.trim()) {
        parts.push(TITO_CORE_FIELD_LABELS[key] + ":\n" + text.trim());
      }
    });
    if (!parts.length) {
      base = SYSTEM_PROMPT;
    } else {
      base = parts.join("\n\n---\n\n");
    }
  }
  const rawMod = contextoModulo && contextoModulo.moduloActivo;
  const mod = ["mentalidad", "diario", "negocio", "trading", "habitos", "general"].includes(rawMod)
    ? rawMod
    : "general";
  const anchor = TITO_MOD_ANCHORS[mod];
  const ops =
    "Reglas finales: español. 1–2 párrafos. Sin títulos/viñetas/etiquetas \"Detecto…\"/\"Corrijo…\". Sin narrar el proceso. No repitas texto largo del usuario ni cites párrafos enteros; resume en una frase si hace falta. Acción clara si aplica problema. Respeta el módulo activo ENFO.";
  if (base === SYSTEM_PROMPT) {
    return (base + "\n\n---\n\n" + anchor + "\n\n" + ops).trim();
  }
  return (base + "\n\n---\n\n" + anchor + "\n\n---\n\n" + ops).trim();
}

function extractResponsesText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  try {
    const o0 = data.output && data.output[0];
    const c0 = o0 && o0.content && o0.content[0];
    if (c0 && typeof c0.text === "string") return c0.text.trim();
  } catch (_) {}
  try {
    const out = data.output;
    if (Array.isArray(out)) {
      for (let i = 0; i < out.length; i++) {
        const item = out[i];
        const content = item && item.content;
        if (Array.isArray(content)) {
          for (let j = 0; j < content.length; j++) {
            const c = content[j];
            if (c && typeof c.text === "string") return c.text.trim();
          }
        }
        if (item && typeof item.text === "string") return item.text.trim();
      }
    }
  } catch (_) {}
  return "";
}

function buildOpenAIInput(
  userText,
  coachHistory,
  coachMemory,
  contextoTiempo,
  contextoEstrategias,
  contextoModulo,
  titoExtras
) {
  const parts = [];
  titoExtras = titoExtras && typeof titoExtras === "object" ? titoExtras : {};

  if (
    titoExtras.titoTimeContext &&
    typeof titoExtras.titoTimeContext === "object"
  ) {
    const tc = titoExtras.titoTimeContext;
    const bits = [];
    if (tc.nowISO) bits.push(`ISO: ${String(tc.nowISO).slice(0, 40)}`);
    if (tc.localDate) bits.push(`fecha local: ${tc.localDate}`);
    if (tc.localTime) bits.push(`hora local: ${tc.localTime}`);
    if (tc.weekday) bits.push(`día: ${tc.weekday}`);
    if (tc.timeZone) bits.push(`zona: ${tc.timeZone}`);
    if (bits.length) {
      parts.push("Reloj del dispositivo (cliente, ahora):\n" + bits.join(", ") + ".");
    }
  }

  if (
    contextoTiempo &&
    typeof contextoTiempo === "object" &&
    (contextoTiempo.fechaISO || contextoTiempo.hora != null)
  ) {
    const bits = [];
    if (contextoTiempo.fechaISO) bits.push(`fecha local: ${contextoTiempo.fechaISO}`);
    if (contextoTiempo.hora != null) {
      const mi = String(contextoTiempo.minuto != null ? contextoTiempo.minuto : 0).padStart(2, "0");
      bits.push(`hora: ${contextoTiempo.hora}:${mi}`);
    }
    if (contextoTiempo.zonaHoraria) bits.push(`zona: ${contextoTiempo.zonaHoraria}`);
    if (contextoTiempo.periodo) bits.push(`periodo del día: ${contextoTiempo.periodo}`);
    if (contextoTiempo.diaSemanaNombre) bits.push(`día: ${contextoTiempo.diaSemanaNombre}`);
    parts.push("Contexto temporal (ahora, cliente):\n" + bits.join(", ") + ".");
  }

  if (contextoModulo && typeof contextoModulo === "object" && contextoModulo.moduloActivo) {
    const ma = String(contextoModulo.moduloActivo).slice(0, 32);
    const pa = contextoModulo.pantallaActiva ? String(contextoModulo.pantallaActiva).slice(0, 64) : "";
    parts.push(
      "Contexto de pantalla ENFO: módulo activo = " +
        ma +
        (pa ? ". Pantalla: " + pa + "." : ".") +
        " Mantén el vocabulario y los ejemplos acordes a ese módulo únicamente."
    );
  }

  if (
    contextoEstrategias &&
    typeof contextoEstrategias === "object" &&
    contextoEstrategias.modulo === "estrategias"
  ) {
    const e = contextoEstrategias;
    let block = "Contexto módulo Estrategias (ENFO):\n";
    block += `Estrategias guardadas en total: ${Number(e.totalEstrategias) || 0}.\n`;
    if (e.viendoDetalle && e.estrategia && typeof e.estrategia === "object") {
      const z = e.estrategia;
      block += "El usuario tiene abierto el detalle de una estrategia ahora.\n";
      block += `Nombre: ${String(z.nombre || "").slice(0, 200)}.\n`;
      block += `Tipo (Call/Put): ${z.tipo === "Put" ? "Put" : "Call"}.\n`;
      block += `Operaciones esta semana: ${Number(z.operacionesSemanaActual) || 0} `;
      block += `(ganadas: ${Number(z.ganadasSemana) || 0}, perdidas: ${Number(z.perdidasSemana) || 0}).\n`;
      block += `Estado semanal (resumen): ${String(z.estadoSemanal || "").slice(0, 300)}.\n`;
    } else {
      block +=
        "El usuario está en la pantalla Estrategias pero no tiene abierto el detalle de una estrategia concreta (lista o vista general).\n";
    }
    parts.push(block);
  }

  if (titoExtras.titoLexikon && typeof titoExtras.titoLexikon === "object") {
    const terms = titoExtras.titoLexikon;
    const keys = Object.keys(terms).slice(0, 24);
    if (keys.length) {
      const lines = keys.map((k) => {
        const o = terms[k];
        const def = o && o.def ? String(o.def).trim().slice(0, 160) : "";
        return def ? `${k}: ${def}` : k;
      });
      parts.push("Términos del usuario (prioridad):\n" + lines.join("\n"));
    }
  }

  if (titoExtras.titoMarcoTemporal && String(titoExtras.titoMarcoTemporal).trim()) {
    parts.push(
      "Marco temporal del mensaje: " +
        String(titoExtras.titoMarcoTemporal).trim() +
        " (pasado=aprendizaje; hoy=ejecución/foco; manana=preparación; semana=seguimiento; plan_semana=planificación)."
    );
  }

  if (titoExtras.contextoBloques && typeof titoExtras.contextoBloques === "object") {
    const cb = titoExtras.contextoBloques;
    const lines = [];
    if (cb.dia) lines.push(`día: ${String(cb.dia).slice(0, 32)}`);
    if (cb.resumen && typeof cb.resumen === "object") {
      const r = cb.resumen;
      lines.push(
        `cumplimiento hoy: ${Number(r.cumplidos) || 0}/${Number(r.total) || 0} bloques (no marcados mal: ${Number(r.noCumplidosMarcados) || 0})`
      );
    }
    if (cb.saturacion && cb.saturacion.saturado) {
      lines.push(`saturación: ${String(cb.saturacion.detalle || "día muy cargado").slice(0, 200)}`);
    }
    if (Array.isArray(cb.bloques)) {
      cb.bloques.slice(0, 14).forEach((b, i) => {
        lines.push(
          `${i + 1}. ${String(b.titulo || "?").slice(0, 48)} ${String(b.horaInicio || "").slice(0, 8)}–${String(
            b.horaFin || ""
          ).slice(0, 8)} [${String(b.estado || "").slice(0, 16)}]`
        );
      });
    }
    if (lines.length) {
      parts.push(
        "Bloques de productividad (horario ENFO). Puedes ser breve y operativo si el usuario pregunta por ellos:\n" +
          lines.join("\n")
      );
    }
  }

  if (Array.isArray(coachMemory) && coachMemory.length) {
    const blocks = coachMemory
      .map((m) => (m && m.text ? String(m.text).trim() : ""))
      .filter(Boolean);
    if (blocks.length) {
      parts.push("Contexto fijo:\n" + blocks.join("\n"));
    }
  }

  if (Array.isArray(coachHistory) && coachHistory.length) {
    const chronological = coachHistory.slice(0, 12).reverse();
    const lines = chronological
      .map((h) => {
        const role = h && h.role === "coach" ? "C" : "U";
        const tx = h && h.text ? String(h.text).trim() : "";
        return tx ? role + ": " + tx.slice(0, 500) : "";
      })
      .filter(Boolean);
    if (lines.length) {
      parts.push("Historial (antiguo→reciente):\n" + lines.join("\n"));
    }
  }

  parts.push("Usuario:\n" + userText);
  return parts.join("\n\n---\n\n");
}

/**
 * Lógica compartida Tito: payload message, userText, coachHistory, coachMemory (coachMemory del cliente no sustituye bloques fijos).
 * @param {object} data - Payload (message, userText, coachHistory, coachMemory)
 */
async function privateCoachChatCore(data) {
  const fromMessage = typeof data.message === "string" ? data.message.trim() : "";
  const fromUserText = typeof data.userText === "string" ? data.userText.trim() : "";
  const userText = fromMessage || fromUserText;
  if (!userText || userText.length > 8000) {
    throw new HttpsError("invalid-argument", "message / userText inválido o demasiado largo.");
  }

  const coachHistory = Array.isArray(data.coachHistory) ? data.coachHistory : [];
  const coachMemory = COACH_MEMORY_INPUT_BLOCKS;
  const contextoTiempo =
    data.contextoTiempo && typeof data.contextoTiempo === "object" ? data.contextoTiempo : null;
  const contextoEstrategias =
    data.contextoEstrategias && typeof data.contextoEstrategias === "object"
      ? data.contextoEstrategias
      : null;
  const contextoModulo =
    data.contextoModulo && typeof data.contextoModulo === "object" ? data.contextoModulo : null;

  const titoExtras = {
    titoTimeContext:
      data.titoTimeContext && typeof data.titoTimeContext === "object" ? data.titoTimeContext : null,
    titoLexikon: data.titoLexikon && typeof data.titoLexikon === "object" ? data.titoLexikon : null,
    titoMarcoTemporal: typeof data.titoMarcoTemporal === "string" ? data.titoMarcoTemporal.trim() : "",
    contextoBloques:
      data.contextoBloques && typeof data.contextoBloques === "object" ? data.contextoBloques : null
  };

  const key = openaiApiKey.value();
  if (!key) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY no configurada en Functions.");
  }

  console.time("[tito] total");
  try {
    console.time("[tito] firestore+prompt");
    const titoCore = await getTitoCoreFromFirestore();
    const instructions = buildTitoSystemPrompt(titoCore, contextoModulo);
    console.log("[tito] instructions:", titoCore ? "firestore" : "fallback");

    const input = buildOpenAIInput(
      userText,
      coachHistory,
      coachMemory,
      contextoTiempo,
      contextoEstrategias,
      contextoModulo,
      titoExtras
    );
    console.timeEnd("[tito] firestore+prompt");

    console.time("[tito] openai");
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        instructions: instructions,
        input: input,
        max_output_tokens: 450
      })
    });

    const json = await resp.json();
    console.timeEnd("[tito] openai");
    if (!resp.ok) {
      const msg =
        json && json.error && json.error.message
          ? json.error.message
          : "Error OpenAI";
      console.error("OpenAI HTTP", resp.status, msg);
      throw new HttpsError("internal", msg);
    }

    const replyRaw = extractResponsesText(json);
    if (!replyRaw) {
      console.error("OpenAI empty output", JSON.stringify(json).slice(0, 500));
      throw new HttpsError("internal", "Respuesta vacía del modelo.");
    }

    const reply = sanitizeTitoReplyByModule(replyRaw, contextoModulo);
    return {reply: reply.slice(0, 4000)};
  } finally {
    try {
      console.timeEnd("[tito] total");
    } catch (_) {}
  }
}

exports.privateCoachChat = onCall(
  {
    region: "us-central1",
    secrets: [openaiApiKey],
    maxInstances: 10,
    timeoutSeconds: 60
  },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "Inicia sesión para usar el coach.");
    }
    const data = request.data || {};
    return privateCoachChatCore(data);
  }
);

exports.privateCoachChatHttp = onRequest(
  {
    region: "us-central1",
    secrets: [openaiApiKey],
    maxInstances: 10,
    timeoutSeconds: 60,
    invoker: "public"
  },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method === "OPTIONS") {
          res.set("Access-Control-Allow-Origin", "*");
          res.set("Access-Control-Allow-Methods", "GET, POST");
          res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.status(204).send("");
          return;
        }

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.split("Bearer ")[1]
          : null;

        if (!token) {
          return res.status(401).json({ error: "No token" });
        }

        const decoded = await admin.auth().verifyIdToken(token);

        const data = req.body || {};

        const result = await privateCoachChatCore(data);

        return res.status(200).json(result);
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message || "Server error" });
      }
    });
  }
);
