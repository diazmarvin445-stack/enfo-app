const admin = require("firebase-admin");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const cors = require("cors")({ origin: true });

if (!admin.apps.length) {
  admin.initializeApp();
}

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const SYSTEM_PROMPT = `
Eres ENFO COACH, un coach de alto rendimiento claro, directo y accesible.

REGLAS:
- Respondes siempre en español.
- Tus respuestas son cortas pero pueden ser naturales (2-4 líneas si es necesario).
- No eres agresivo, sarcástico ni grosero.
- No juzgas al usuario.
- No das motivación vacía.
- No repites lo que dice el usuario.

ESTILO:
- Directo pero humano
- Profesional y accesible
- Natural, como una persona real
- Claro y sin rodeos
- Enfocado en soluciones

FORMATO:
- 1 idea clara
- 1 acción inmediata

COMPORTAMIENTO:
- Puedes saludar si el usuario saluda.
- Si el usuario está perdido, le das claridad.
- Si está desmotivado, le das una acción pequeña.
- Si solo saluda, respondes natural (no das órdenes).
- No fuerces frases motivacionales.

IMPORTANTE:
Siempre termina con una acción concreta cuando el usuario plantea un problema.
No respondas solo con reflexión.

EJEMPLOS:

Usuario: "Hola"
Respuesta: "Hola, ¿en qué quieres avanzar hoy?"

Usuario: "No tengo ganas"
Respuesta: "Empieza con algo pequeño. Haz una tarea de 2 minutos ahora."

Usuario: "Estoy procrastinando"
Respuesta: "Reduce la tarea a lo más simple posible y hazla ahora."

Usuario: "No sé qué hacer"
Respuesta: "Elige el siguiente paso más simple y ejecútalo."
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

/** Siempre los mismos cuatro bloques (Deseo → Claridad → Decisión → Estructura mental); no se concatena con datos dinámicos del cliente. */
const COACH_MEMORY_FIXED_BLOCKS = Object.freeze([
  {text: ENFO_BASE_COACH_MEMORY_TEXT},
  {text: ENFO_CLARIDAD_COACH_MEMORY_TEXT},
  {text: ENFO_DECISION_COACH_MEMORY_TEXT},
  {text: ENFO_ESTRUCTURA_MENTAL_COACH_MEMORY_TEXT}
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
  try {
    const snap = await admin.firestore().collection("tito_brain").doc("core").get();
    if (!snap.exists) {
      console.log("[tito] core: documento ausente");
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
      return null;
    }
    return out;
  } catch (err) {
    console.error("[tito] getTitoCoreFromFirestore:", err && err.message ? err.message : err);
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
  const ops = `
REGLAS OPERATIVAS (fijas):
- Responde siempre en español.
- Tono firme, claro, estratégico y orientado a acción.
- No humilles ni insultes; no suavices la verdad innecesariamente.
- Cuando el usuario plantee un problema, cierra con una acción concreta (no solo reflexión).
- Respuestas breves salvo que el contexto pida algo más.
`.trim();
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
      parts.push(
        "CONTEXTO BASE ENFO (obligatorio — marco fijo antes del historial y del mensaje actual):\n\n" +
          blocks.join("\n\n---\n\n")
      );
    }
  }

  if (Array.isArray(coachHistory) && coachHistory.length) {
    const chronological = coachHistory.slice(0, 24).reverse();
    const lines = chronological
      .map((h) => {
        const role = h && h.role === "coach" ? "Coach" : "Usuario";
        const tx = h && h.text ? String(h.text).trim() : "";
        return tx ? role + ": " + tx.slice(0, 1500) : "";
      })
      .filter(Boolean);
    if (lines.length) {
      parts.push("Turnos recientes (más antiguo primero):\n" + lines.join("\n"));
    }
  }

  parts.push("Mensaje actual del usuario:\n" + userText);
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
  const coachMemory = COACH_MEMORY_FIXED_BLOCKS;

  const key = openaiApiKey.value();
  if (!key) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY no configurada en Functions.");
  }

  const titoCore = await getTitoCoreFromFirestore();
  const instructions = buildTitoSystemPrompt(titoCore);
  console.log("[tito] instructions:", titoCore ? "firestore" : "fallback");

  const input = buildOpenAIInput(userText, coachHistory, coachMemory);

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      instructions: instructions,
      input: input
    })
  });

  const json = await resp.json();
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
