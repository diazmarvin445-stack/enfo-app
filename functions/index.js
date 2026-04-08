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

/**
 * Construye instructions para OpenAI desde Firestore; si titoCore es null o vacío, usa SYSTEM_PROMPT.
 */
function buildTitoSystemPrompt(titoCore) {
  if (!titoCore || typeof titoCore !== "object") {
    return SYSTEM_PROMPT;
  }
  const parts = [];
  Object.keys(TITO_CORE_FIELD_LABELS).forEach((key) => {
    const text = titoCore[key];
    if (typeof text === "string" && text.trim()) {
      parts.push(TITO_CORE_FIELD_LABELS[key] + ":\n" + text.trim());
    }
  });
  if (!parts.length) {
    return SYSTEM_PROMPT;
  }
  const base = parts.join("\n\n---\n\n");
  const ops = `Reglas finales: español. 1–2 párrafos. Sin títulos/viñetas/etiquetas "Detecto…"/"Corrijo…". Sin narrar el proceso. Acción clara si aplica problema.`;
  return (base + "\n\n---\n\n" + ops).trim();
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

function buildOpenAIInput(userText, coachHistory, coachMemory) {
  const parts = [];

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

  const key = openaiApiKey.value();
  if (!key) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY no configurada en Functions.");
  }

  console.time("[tito] total");
  try {
    console.time("[tito] firestore+prompt");
    const titoCore = await getTitoCoreFromFirestore();
    const instructions = buildTitoSystemPrompt(titoCore);
    console.log("[tito] instructions:", titoCore ? "firestore" : "fallback");

    const input = buildOpenAIInput(userText, coachHistory, coachMemory);
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

    const reply = extractResponsesText(json);
    if (!reply) {
      console.error("OpenAI empty output", JSON.stringify(json).slice(0, 500));
      throw new HttpsError("internal", "Respuesta vacía del modelo.");
    }

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
