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

if (!SUPABASE_URL) {
  throw new Error("Mangler SUPABASE_URL i miljøvariabler");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Mangler SUPABASE_SERVICE_ROLE_KEY i miljøvariabler");
}
if (!ANTHROPIC_API_KEY) {
  throw new Error("Mangler ANTHROPIC_API_KEY i miljøvariabler");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `
Du er en nøyaktig dataekstraktor for vognlister og batteritabeller.

Du skal ALLTID svare med en ren JSON-array.
Ikke bruk markdown.
Ikke bruk kodeblokker.
Ikke skriv forklaringer.
Ikke skriv tekst før eller etter JSON.
Ikke returner et objekt.
Returner kun dette formatet:

[
  {
    "bilmerke": "",
    "modell": "",
    "fra_aar": null,
    "til_aar": null,
    "motortype": "",
    "ah": null,
    "cca": null,
    "dimensjon": "",
    "polplassering": "",
    "batteritype": "",
    "varenummer": ""
  }
]

Hvis ingen rader finnes, returner [].
Hent kun ut data som faktisk står i dokumentet.
Ikke gjett manglende verdier.
`;

function normalizeRow(row, sourceFileName = "") {
  return {
    bilmerke: row?.bilmerke ?? "",
    modell: row?.modell ?? "",
    fra_aar:
      row?.fra_aar === null || row?.fra_aar === undefined || row?.fra_aar === ""
        ? null
        : Number(row.fra_aar),
    til_aar:
      row?.til_aar === null || row?.til_aar === undefined || row?.til_aar === ""
        ? null
        : Number(row.til_aar),
    motortype: row?.motortype ?? "",
    ah:
      row?.ah === null || row?.ah === undefined || row?.ah === ""
        ? null
        : Number(row.ah),
    cca:
      row?.cca === null || row?.cca === undefined || row?.cca === ""
        ? null
        : Number(row.cca),
    dimensjon: row?.dimensjon ?? "",
    polplassering: row?.polplassering ?? "",
    batteritype: row?.batteritype ?? "",
    varenummer: row?.varenummer ?? "",
    source_file_name: sourceFileName ?? "",
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

  throw new Error(`Klarte ikke å parse JSON-array fra modellen. Råsvar: ${raw.slice(0, 1000)}`);
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
  try {
    const { b64, instruction, sourceFileName } = req.body;

    if (!b64 || !instruction) {
      return res.status(400).json({ error: "Mangler b64 eller instruction" });
    }

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 32000,
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

    const anthropicData = await anthropicResp.json();

    if (!anthropicResp.ok) {
      return res.status(anthropicResp.status).json({
        error: anthropicData?.error?.message || "Feil fra Anthropic API",
        raw: anthropicData,
      });
    }

    const text =
      anthropicData?.content?.map((block) => block?.text || "").join("\n").trim() || "";

    let parsedRows;
    try {
      parsedRows = tryParseJSONArray(text);
    } catch (parseError) {
      return res.status(500).json({
        error: parseError.message,
        rawText: text,
      });
    }

    const rows = parsedRows.map((r) => normalizeRow(r, sourceFileName));

    return res.json({
      rows,
      rawText: text,
    });
  } catch (error) {
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
