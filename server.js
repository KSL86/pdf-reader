import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL) throw new Error("Mangler SUPABASE_URL i miljøvariabler");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Mangler SUPABASE_SERVICE_ROLE_KEY i miljøvariabler");
if (!ANTHROPIC_API_KEY) throw new Error("Mangler ANTHROPIC_API_KEY i miljøvariabler");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `
Du er en nøyaktig dataekstraktor for vognlister og batteritabeller.

Du skal ALLTID svare med en ren JSON-array.
Ikke bruk markdown.
Ikke bruk kodeblokker.
Ikke skriv forklaringer.
Ikke skriv tekst før eller etter JSON.
Ikke returner et objekt.
Returner kun [] hvis ingen rader finnes.

Hvert objekt skal ha disse feltene:
bilmerke, modell, fra_aar, til_aar, motortype, ah, cca, dimensjon, polplassering, batteritype, varenummer

Hent kun ut data som faktisk står i dokumentet.
Ikke gjett manglende verdier.
`;

function makeFingerprint(row) {
  return [
    row?.bilmerke ?? "",
    row?.modell ?? "",
    row?.fra_aar ?? "",
    row?.til_aar ?? "",
    row?.motortype ?? "",
    row?.ah ?? "",
    row?.cca ?? "",
    row?.dimensjon ?? "",
    row?.polplassering ?? "",
    row?.batteritype ?? "",
    row?.varenummer ?? "",
    row?.source_file_name ?? "",
  ].join("|");
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row, sourceFileName = "") {
  const normalized = {
    bilmerke: row?.bilmerke ?? "",
    modell: row?.modell ?? "",
    fra_aar: normalizeNumber(row?.fra_aar),
    til_aar: normalizeNumber(row?.til_aar),
    motortype: row?.motortype ?? "",
    ah: normalizeNumber(row?.ah),
    cca: normalizeNumber(row?.cca),
    dimensjon: row?.dimensjon ?? "",
    polplassering: row?.polplassering ?? "",
    batteritype: row?.batteritype ?? "",
    varenummer: row?.varenummer ?? "",
    source_file_name: sourceFileName ?? "",
  };

  return {
    ...normalized,
    fingerprint: makeFingerprint(normalized),
  };
}

function tryParseJSONArray(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    throw new Error("Modellen returnerte tomt svar");
  }

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
  } catch {}

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    const candidate = cleaned.slice(arrayStart, arrayEnd + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const candidate = cleaned.slice(objStart, objEnd + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
    } catch {}
  }

  throw new Error(`Klarte ikke å parse JSON-array fra modellen. Råsvar: ${raw.slice(0, 1200)}`);
}

async function readResponseSafely(resp) {
  const text = await resp.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

app.get("/api/health", (_req, res) => {
  return res.json({ ok: true });
});

app.get("/api/rows", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("battery_rows")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ rows: data || [] });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved henting av rader",
    });
  }
});

app.post("/api/rows", async (req, res) => {
  try {
    const { rows, sourceFileName } = req.body;

    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "rows må være en array" });
    }

    const normalized = rows.map((r) => normalizeRow(r, sourceFileName));

    if (normalized.length === 0) {
      return res.json({ inserted: 0, rows: [] });
    }

    const { data, error } = await supabase
      .from("battery_rows")
      .insert(normalized)
      .select("*");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      inserted: data?.length || 0,
      rows: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved lagring av rader",
    });
  }
});

app.delete("/api/rows", async (_req, res) => {
  try {
    const { error } = await supabase
      .from("battery_rows")
      .delete()
      .not("id", "is", null);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved sletting av rader",
    });
  }
});

app.post("/api/extract", async (req, res) => {
  const startedAt = Date.now();

  try {
    const { b64, instruction, sourceFileName } = req.body;

    if (!b64 || !instruction) {
      return res.status(400).json({ error: "Mangler b64 eller instruction" });
    }

    console.log("[extract] Start", {
      sourceFileName,
      b64Length: b64.length,
      instructionPreview: instruction.slice(0, 160),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    let anthropicResp;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 12000,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: b64,
                  },
                },
                {
                  type: "text",
                  text: instruction,
                },
              ],
            },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    const { text: rawAnthropicText, json: anthropicJson } = await readResponseSafely(anthropicResp);

    if (!anthropicResp.ok) {
      console.error("[extract] Anthropic error", {
        status: anthropicResp.status,
        bodyPreview: rawAnthropicText.slice(0, 1200),
      });

      return res.status(anthropicResp.status).json({
        error:
          anthropicJson?.error?.message ||
          `Feil fra Anthropic API (${anthropicResp.status})`,
        raw: anthropicJson || rawAnthropicText.slice(0, 1200),
      });
    }

    if (!anthropicJson) {
      console.error("[extract] Anthropic svarte ikke med JSON", rawAnthropicText.slice(0, 1200));
      return res.status(500).json({
        error: "Anthropic svarte ikke med gyldig JSON",
        raw: rawAnthropicText.slice(0, 1200),
      });
    }

    const text =
      anthropicJson?.content?.map((block) => block?.text || "").join("\n").trim() || "";

    let parsedRows;
    try {
      parsedRows = tryParseJSONArray(text);
    } catch (parseError) {
      console.error("[extract] Parsefeil", parseError.message);
      return res.status(500).json({
        error: parseError.message,
        rawText: text.slice(0, 1200),
      });
    }

    const rows = parsedRows.map((r) => normalizeRow(r, sourceFileName));

    console.log("[extract] Ferdig", {
      rowCount: rows.length,
      ms: Date.now() - startedAt,
    });

    return res.json({
      rows,
      rawText: text.slice(0, 1200),
    });
  } catch (error) {
    console.error("[extract] Uventet feil", error);

    if (error?.name === "AbortError") {
      return res.status(504).json({
        error: "Kallet til Anthropic tok for lang tid og ble avbrutt",
      });
    }

    return res.status(500).json({
      error: error?.message || "Ukjent serverfeil",
    });
  }
});

app.use(express.static("dist"));

app.get("*", (_req, res) => {
  return res.sendFile(new URL("./dist/index.html", import.meta.url).pathname);
});

app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});
