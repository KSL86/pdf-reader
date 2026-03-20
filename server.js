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

Regler:
- Hent kun ut data som faktisk står i dokumentet.
- Ikke gjett manglende verdier.
- Hvis et felt mangler, bruk null eller tom streng.
- En rad per faktisk tabellrad.
`;

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function makeFingerprint(row) {
  return [
    row.bilmerke,
    row.modell,
    row.fra_aar ?? "",
    row.til_aar ?? "",
    row.motortype,
    row.ah ?? "",
    row.cca ?? "",
    row.dimensjon,
    row.polplassering,
    row.batteritype,
    row.varenummer,
    row.source_file_name,
    row.page_number ?? "",
  ].join("|");
}

function normalizeRow(row, sourceFileName = "", pageNumber = null, rawModelOutput = "") {
  const normalized = {
    bilmerke: cleanText(row?.bilmerke),
    modell: cleanText(row?.modell),
    fra_aar: normalizeNumber(row?.fra_aar),
    til_aar: normalizeNumber(row?.til_aar),
    motortype: cleanText(row?.motortype),
    ah: normalizeNumber(row?.ah),
    cca: normalizeNumber(row?.cca),
    dimensjon: cleanText(row?.dimensjon),
    polplassering: cleanText(row?.polplassering),
    batteritype: cleanText(row?.batteritype),
    varenummer: cleanText(row?.varenummer),
    source_file_name: cleanText(sourceFileName),
    page_number: pageNumber,
    raw_model_output: rawModelOutput || "",
  };

  return {
    ...normalized,
    fingerprint: makeFingerprint(normalized),
  };
}

function validateRow(row) {
  const errors = [];

  if (!row.bilmerke) errors.push("Mangler bilmerke");
  if (!row.modell) errors.push("Mangler modell");

  if (row.fra_aar !== null && (row.fra_aar < 1950 || row.fra_aar > 2100)) {
    errors.push("Ugyldig fra_aar");
  }

  if (row.til_aar !== null && (row.til_aar < 1950 || row.til_aar > 2100)) {
    errors.push("Ugyldig til_aar");
  }

  if (
    row.fra_aar !== null &&
    row.til_aar !== null &&
    row.til_aar < row.fra_aar
  ) {
    errors.push("til_aar er mindre enn fra_aar");
  }

  if (row.ah !== null && (row.ah < 1 || row.ah > 400)) {
    errors.push("Ugyldig Ah");
  }

  if (row.cca !== null && (row.cca < 1 || row.cca > 3000)) {
    errors.push("Ugyldig CCA");
  }

  if (!row.varenummer) {
    errors.push("Mangler varenummer");
  }

  return {
    validation_status: errors.length === 0 ? "valid" : "needs_review",
    validation_errors: errors,
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

app.get("/api/staging-rows", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("battery_rows_staging")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ rows: data || [] });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved henting av staging-rader",
    });
  }
});

app.get("/api/final-rows", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("battery_rows_final")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ rows: data || [] });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved henting av endelige rader",
    });
  }
});

app.delete("/api/staging-rows", async (_req, res) => {
  try {
    const { error } = await supabase
      .from("battery_rows_staging")
      .delete()
      .not("id", "is", null);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved sletting av staging-rader",
    });
  }
});

app.delete("/api/final-rows", async (_req, res) => {
  try {
    const { error } = await supabase
      .from("battery_rows_final")
      .delete()
      .not("id", "is", null);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved sletting av final-rader",
    });
  }
});

app.post("/api/extract", async (req, res) => {
  try {
    const { b64, instruction, sourceFileName, pageNumber } = req.body;

    if (!b64 || !instruction) {
      return res.status(400).json({ error: "Mangler b64 eller instruction" });
    }

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
      return res.status(anthropicResp.status).json({
        error:
          anthropicJson?.error?.message ||
          `Feil fra Anthropic API (${anthropicResp.status})`,
        raw: anthropicJson || rawAnthropicText.slice(0, 1200),
      });
    }

    if (!anthropicJson) {
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
      return res.status(500).json({
        error: parseError.message,
        rawText: text.slice(0, 1200),
      });
    }

    const rows = parsedRows.map((r) =>
      normalizeRow(r, sourceFileName, pageNumber, text)
    );

    return res.json({
      rows,
      rawText: text.slice(0, 1200),
    });
  } catch (error) {
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

app.post("/api/staging-rows", async (req, res) => {
  try {
    const { rows } = req.body;

    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "rows må være en array" });
    }

    const prepared = rows.map((incomingRow) => {
      const row = {
        bilmerke: incomingRow?.bilmerke ?? "",
        modell: incomingRow?.modell ?? "",
        fra_aar: incomingRow?.fra_aar ?? null,
        til_aar: incomingRow?.til_aar ?? null,
        motortype: incomingRow?.motortype ?? "",
        ah: incomingRow?.ah ?? null,
        cca: incomingRow?.cca ?? null,
        dimensjon: incomingRow?.dimensjon ?? "",
        polplassering: incomingRow?.polplassering ?? "",
        batteritype: incomingRow?.batteritype ?? "",
        varenummer: incomingRow?.varenummer ?? "",
        source_file_name: incomingRow?.source_file_name ?? "",
        page_number: incomingRow?.page_number ?? null,
        raw_model_output: incomingRow?.raw_model_output ?? "",
        fingerprint: incomingRow?.fingerprint ?? "",
      };

      const validated = validateRow(row);

      return {
        ...row,
        validation_status: validated.validation_status,
        validation_errors: validated.validation_errors,
      };
    });

    if (prepared.length === 0) {
      return res.json({ inserted: 0, updated: 0, rows: [] });
    }

    const { data, error } = await supabase
      .from("battery_rows_staging")
      .upsert(prepared, { onConflict: "fingerprint" })
      .select("*");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const validCount = prepared.filter((r) => r.validation_status === "valid").length;
    const reviewCount = prepared.filter((r) => r.validation_status !== "valid").length;

    return res.json({
      inserted_or_updated: data?.length || 0,
      validCount,
      reviewCount,
      rows: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved lagring til staging",
    });
  }
});

app.post("/api/promote-valid-rows", async (_req, res) => {
  try {
    const { data: validRows, error: fetchError } = await supabase
      .from("battery_rows_staging")
      .select("*")
      .eq("validation_status", "valid");

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!validRows || validRows.length === 0) {
      return res.json({ promoted: 0 });
    }

    const rowsForFinal = validRows.map((row) => ({
      bilmerke: row.bilmerke,
      modell: row.modell,
      fra_aar: row.fra_aar,
      til_aar: row.til_aar,
      motortype: row.motortype,
      ah: row.ah,
      cca: row.cca,
      dimensjon: row.dimensjon,
      polplassering: row.polplassering,
      batteritype: row.batteritype,
      varenummer: row.varenummer,
      source_file_name: row.source_file_name,
      page_number: row.page_number,
      fingerprint: row.fingerprint,
      imported_from_staging_id: row.id,
    }));

    const { data, error } = await supabase
      .from("battery_rows_final")
      .upsert(rowsForFinal, { onConflict: "fingerprint" })
      .select("*");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      promoted: data?.length || 0,
      rows: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Feil ved flytting til final-tabell",
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
