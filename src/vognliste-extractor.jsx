import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
const COLS = [
  { key: "bilmerke", label: "Bilmerke" },
  { key: "modell", label: "Modell" },
  { key: "fra_aar", label: "Fra år" },
  { key: "til_aar", label: "Til år" },
  { key: "motortype", label: "Motor" },
  { key: "ah", label: "Ah" },
  { key: "cca", label: "CCA" },
  { key: "dimensjon", label: "Dim. (mm)" },
  { key: "polplassering", label: "Pol" },
  { key: "batteritype", label: "Type" },
  { key: "varenummer", label: "Varenr." },
  { key: "source_file_name", label: "Kilde" },
];

const PAGES_PER_BATCH = 10;

function toCSV(rows) {
  const header = COLS.map((c) => c.label).join(";");
  const lines = rows.map((r) =>
    COLS.map((c) => {
      const value = r?.[c.key] ?? "";
      const text = String(value).replace(/"/g, '""');
      return text.includes(";") || text.includes('"') || text.includes("\n")
        ? `"${text}"`
        : text;
    }).join(";")
  );
  return [header, ...lines].join("\n");
}

function downloadCSV(rows, filename = "battery_rows.csv") {
  const csv = "\uFEFF" + toCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function normalizeRow(row) {
  return {
    bilmerke: row?.bilmerke ?? "",
    modell: row?.modell ?? "",
    fra_aar: row?.fra_aar ?? null,
    til_aar: row?.til_aar ?? null,
    motortype: row?.motortype ?? "",
    ah: row?.ah ?? null,
    cca: row?.cca ?? null,
    dimensjon: row?.dimensjon ?? "",
    polplassering: row?.polplassering ?? "",
    batteritype: row?.batteritype ?? "",
    varenummer: row?.varenummer ?? "",
    source_file_name: row?.source_file_name ?? "",
  };
}

function dedupeRows(rows) {
  const seen = new Set();
  const result = [];

  for (const row of rows) {
    const normalized = normalizeRow(row);
    const key = [
      normalized.bilmerke,
      normalized.modell,
      normalized.fra_aar,
      normalized.til_aar,
      normalized.motortype,
      normalized.ah,
      normalized.cca,
      normalized.dimensjon,
      normalized.polplassering,
      normalized.batteritype,
      normalized.varenummer,
      normalized.source_file_name,
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function getPdfPageCount(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  return pdf.numPages;
}

export default function VognlisteExtractor() {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState("bilmerke");
  const [sortDir, setSortDir] = useState("asc");
  const [append, setAppend] = useState(false);
  const [dbCount, setDbCount] = useState(0);
  const [loadingDb, setLoadingDb] = useState(true);
  const [isCancelling, setIsCancelling] = useState(false);

  const inputRef = useRef(null);
  const abortRef = useRef(null);

  const loadRowsFromDatabase = useCallback(async () => {
    try {
      setLoadingDb(true);
      const resp = await fetch("/api/rows");
      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data?.error || `Klarte ikke å hente rader (${resp.status})`);
      }

      const incomingRows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
      setRows(incomingRows);
      setDbCount(incomingRows.length);
    } catch (err) {
      setErrorMsg(err?.message || "Feil ved lasting fra database");
    } finally {
      setLoadingDb(false);
    }
  }, []);

  useEffect(() => {
    loadRowsFromDatabase();
  }, [loadRowsFromDatabase]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const dropped = e.dataTransfer?.files?.[0] || e.target?.files?.[0] || null;

    if (!dropped) return;

    if (dropped.type !== "application/pdf") {
      setErrorMsg("Kun PDF-filer er støttet.");
      return;
    }

    setFile(dropped);
    setErrorMsg("");
    setSuccessMsg("");
  }, []);

  const cancelExtraction = useCallback(() => {
    setIsCancelling(true);
    abortRef.current?.abort();
    setProgress("Avbryter prosess...");
  }, []);

  const saveRowsToDatabase = useCallback(async (newRows, sourceFileName) => {
    const resp = await fetch("/api/rows", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rows: newRows,
        sourceFileName,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data?.error || `Klarte ikke å lagre rader (${resp.status})`);
    }

    return Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
  }, []);

  const clearDatabase = useCallback(async () => {
    const confirmed = window.confirm("Vil du slette alle rader fra Supabase?");
    if (!confirmed) return;

    try {
      setStatus("loading");
      setProgress("Tømmer database...");
      setErrorMsg("");
      setSuccessMsg("");

      const resp = await fetch("/api/rows", {
        method: "DELETE",
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data?.error || `Klarte ikke å tømme database (${resp.status})`);
      }

      setRows([]);
      setDbCount(0);
      setStatus("done");
      setProgress("");
      setSuccessMsg("Databasen er tømt.");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err?.message || "Feil ved tømming av database");
    }
  }, []);

  const extract = useCallback(async () => {
    if (!file) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsCancelling(false);

    try {
      setStatus("loading");
      setProgress("Leser PDF...");
      setErrorMsg("");
      setSuccessMsg("");

      const b64 = await fileToBase64(file);
      const totalPages = await getPdfPageCount(file);

      if (!totalPages || totalPages < 1) {
        throw new Error("Kunne ikke lese antall sider i PDF-en.");
      }

      const totalBatches = Math.ceil(totalPages / PAGES_PER_BATCH);
      let extractedRows = [];

      for (let batch = 0; batch < totalBatches; batch += 1) {
        if (controller.signal.aborted) {
          throw new Error("Prosessen ble avbrutt.");
        }

        const fromPage = batch * PAGES_PER_BATCH + 1;
        const toPage = Math.min((batch + 1) * PAGES_PER_BATCH, totalPages);

        setProgress(`Ekstraherer side ${fromPage}–${toPage} av ${totalPages}...`);

        const instruction = `Ekstraher KUN oppføringene fra side ${fromPage} til og med side ${toPage}.
Svar KUN med en JSON-array.
Hvert objekt skal ha feltene:
bilmerke, modell, fra_aar, til_aar, motortype, ah, cca, dimensjon, polplassering, batteritype, varenummer.
Ikke inkluder forklaringstekst.`;

        const resp = await fetch("/api/extract", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            b64,
            instruction,
            sourceFileName: file.name,
          }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          throw new Error(data?.error || `Ekstrahering feilet (${resp.status})`);
        }

        const batchRows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
        extractedRows = dedupeRows([...extractedRows, ...batchRows]);
        setRows((prev) => (append ? dedupeRows([...prev, ...batchRows]) : [...extractedRows]));
      }

      if (extractedRows.length === 0) {
        setStatus("done");
        setProgress("");
        setSuccessMsg("Ingen rader ble funnet i dokumentet.");
        return;
      }

      setProgress("Lagrer til database...");
      const savedRows = await saveRowsToDatabase(extractedRows, file.name);

      if (append) {
        setRows((prev) => dedupeRows([...prev, ...savedRows]));
      } else {
        await loadRowsFromDatabase();
      }

      const finalCount = append
        ? dedupeRows([...(append ? rows : []), ...savedRows]).length
        : null;

      setDbCount((current) => (append ? Math.max(current, finalCount ?? current) : savedRows.length || current));
      setStatus("done");
      setProgress("");
      setSuccessMsg(`${savedRows.length} rader lagret til Supabase.`);
      await loadRowsFromDatabase();
    } catch (err) {
      if (err?.name === "AbortError") {
        setStatus("idle");
        setProgress("");
        setSuccessMsg("Prosessen ble avbrutt.");
      } else {
        setStatus("error");
        setProgress("");
        setErrorMsg(err?.message || "Ukjent feil under ekstrahering");
      }
    } finally {
      abortRef.current = null;
      setIsCancelling(false);
    }
  }, [append, file, loadRowsFromDatabase, rows, saveRowsToDatabase]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase();

    if (!q) return rows;

    return rows.filter((row) =>
      Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(q))
    );
  }, [filter, rows]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];

    copy.sort((a, b) => {
      const av = a?.[sortKey] ?? "";
      const bv = b?.[sortKey] ?? "";
      const result = String(av).localeCompare(String(bv), "nb", { numeric: true });
      return sortDir === "asc" ? result : -result;
    });

    return copy;
  }, [filteredRows, sortDir, sortKey]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0f0f0f",
        color: "#e8e0d0",
        fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #161616; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .btn {
          cursor: pointer;
          border: none;
          padding: 11px 16px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: .05em;
          transition: .15s ease;
        }
        .btn:disabled {
          opacity: .55;
          cursor: not-allowed;
        }
        .btn-primary {
          background: #f5a623;
          color: #111;
        }
        .btn-primary:hover:not(:disabled) {
          background: #ffbe47;
        }
        .btn-secondary {
          background: transparent;
          color: #f5a623;
          border: 1px solid #f5a623;
        }
        .btn-secondary:hover:not(:disabled) {
          background: #1a1500;
        }
        .btn-danger {
          background: #2a1111;
          color: #ff8d8d;
          border: 1px solid #5a1a1a;
        }
        .btn-danger:hover:not(:disabled) {
          background: #351616;
        }
        .panel {
          background: #141414;
          border: 1px solid #262626;
        }
        .drop-zone {
          border: 2px dashed #333;
          padding: 28px;
          text-align: center;
          cursor: pointer;
          background: #141414;
          transition: .2s ease;
        }
        .drop-zone:hover,
        .drop-zone.over {
          border-color: #f5a623;
          background: #1a1500;
        }
        .pulse {
          animation: pulse 1.3s ease-in-out infinite;
        }
        @keyframes pulse {
          0%,100% { opacity: 1; }
          50% { opacity: .35; }
        }
        .th-btn {
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
        }
        .th-btn:hover {
          color: #f5a623;
        }
        .row-hover:hover {
          background: #1a1800 !important;
        }
      `}</style>

      <div
        style={{
          background: "#1a1a1a",
          borderBottom: "2px solid #f5a623",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <div style={{ fontSize: "22px" }}>🔋</div>
        <div>
          <div
            style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "18px",
              fontWeight: 700,
              letterSpacing: ".05em",
              color: "#f5a623",
            }}
          >
            VOGNLISTE EKSTRAKTOR
          </div>
          <div style={{ fontSize: "11px", color: "#666", letterSpacing: ".1em" }}>
            BATTERI DATABASE BUILDER — SUPABASE
          </div>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: "10px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div
            className="panel"
            style={{
              padding: "6px 12px",
              color: "#aaa",
              fontSize: "13px",
            }}
          >
            Database: <span style={{ color: "#f5a623", fontWeight: 700 }}>{dbCount}</span> rader
          </div>
          {loadingDb && <div style={{ fontSize: "12px", color: "#777" }}>Laster database...</div>}
        </div>
      </div>

      <div style={{ padding: "24px", maxWidth: "1600px", margin: "0 auto" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: "16px",
            marginBottom: "20px",
          }}
        >
          <div
            className="drop-zone"
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add("over");
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove("over")}
            onDrop={(e) => {
              e.currentTarget.classList.remove("over");
              handleDrop(e);
            }}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={handleDrop}
            />
            {file ? (
              <div>
                <div style={{ fontSize: "28px", marginBottom: "6px" }}>📄</div>
                <div style={{ color: "#f5a623", fontWeight: 600 }}>{file.name}</div>
                <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>
                  {(file.size / 1024 / 1024).toFixed(1)} MB — klikk for å bytte fil
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: "32px", marginBottom: "8px", opacity: 0.4 }}>📁</div>
                <div style={{ color: "#888", fontSize: "13px" }}>
                  Dra og slipp PDF her, eller klikk for å velge
                </div>
                <div style={{ fontSize: "11px", color: "#555", marginTop: "4px" }}>
                  Scannede vognlister støttes
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <button
              className="btn btn-primary"
              disabled={!file || status === "loading"}
              onClick={extract}
            >
              {status === "loading" ? "⏳ PROSESSERER..." : "▶ EKSTRAHER OG LAGRE"}
            </button>

            {status === "loading" && (
              <button
                className="btn btn-danger"
                disabled={isCancelling}
                onClick={cancelExtraction}
              >
                {isCancelling ? "AVBRYTER..." : "■ AVBRYT"}
              </button>
            )}

            <label
              className="panel"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "12px",
                color: "#888",
                padding: "10px",
              }}
            >
              <input
                type="checkbox"
                checked={append}
                onChange={(e) => setAppend(e.target.checked)}
                style={{ accentColor: "#f5a623" }}
              />
              Legg nye rader til eksisterende data
            </label>

            {rows.length > 0 && (
              <button className="btn btn-secondary" onClick={() => downloadCSV(rows)}>
                ⬇ LAST NED CSV
              </button>
            )}

            <button className="btn btn-danger" onClick={clearDatabase} disabled={status === "loading"}>
              🗑 TØM SUPABASE
            </button>
          </div>
        </div>

        {status === "loading" && (
          <div
            style={{
              background: "#141400",
              border: "1px solid #3a3000",
              padding: "12px 16px",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <div className="pulse" style={{ color: "#f5a623", fontSize: "16px" }}>
              ◉
            </div>
            <span style={{ fontSize: "13px", color: "#cca020" }}>{progress}</span>
          </div>
        )}

        {!!successMsg && (
          <div
            style={{
              background: "#001a08",
              border: "1px solid #1a5c30",
              padding: "12px 16px",
              marginBottom: "16px",
              fontSize: "13px",
              color: "#4caf50",
            }}
          >
            ✓ {successMsg}
          </div>
        )}

        {!!errorMsg && (
          <div
            style={{
              background: "#1a0000",
              border: "1px solid #5c1a1a",
              padding: "12px 16px",
              marginBottom: "16px",
              fontSize: "13px",
              color: "#f44336",
            }}
          >
            ✗ {errorMsg}
          </div>
        )}

        {rows.length > 0 && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              <input
                type="text"
                placeholder="Søk i alle felter..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  color: "#e8e0d0",
                  padding: "8px 12px",
                  fontFamily: "inherit",
                  fontSize: "13px",
                  flex: 1,
                  outline: "none",
                }}
              />
              <div style={{ fontSize: "12px", color: "#555", whiteSpace: "nowrap" }}>
                {sortedRows.length} / {rows.length} rader
              </div>
            </div>

            <div style={{ overflowX: "auto", border: "1px solid #2a2a2a" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ background: "#1a1a1a", borderBottom: "2px solid #f5a623" }}>
                    <th
                      style={{
                        padding: "8px 10px",
                        color: "#555",
                        fontWeight: 400,
                        width: "40px",
                        textAlign: "center",
                      }}
                    >
                      #
                    </th>
                    {COLS.map((c) => (
                      <th
                        key={c.key}
                        className="th-btn"
                        onClick={() => toggleSort(c.key)}
                        style={{
                          padding: "8px 10px",
                          textAlign: "left",
                          color: sortKey === c.key ? "#f5a623" : "#888",
                          fontWeight: sortKey === c.key ? 600 : 400,
                          letterSpacing: ".06em",
                          fontSize: "11px",
                        }}
                      >
                        {c.label} {sortKey === c.key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => (
                    <tr
                      key={`${r.id ?? "row"}-${i}`}
                      className="row-hover"
                      style={{
                        borderBottom: "1px solid #1e1e1e",
                        background: i % 2 === 0 ? "#0f0f0f" : "#121212",
                      }}
                    >
                      <td style={{ padding: "6px 10px", color: "#444", textAlign: "center" }}>
                        {i + 1}
                      </td>
                      {COLS.map((c) => (
                        <td
                          key={c.key}
                          style={{
                            padding: "6px 10px",
                            color:
                              c.key === "bilmerke" || c.key === "modell"
                                ? "#e8e0d0"
                                : c.key === "ah" || c.key === "cca"
                                  ? "#f5a623"
                                  : "#aaa",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r?.[c.key] ?? <span style={{ color: "#333" }}>—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rows.length === 0 && status !== "loading" && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#333" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px", opacity: 0.3 }}>🔋</div>
            <div style={{ fontSize: "13px", letterSpacing: ".1em" }}>
              INGEN DATA ENNÅ — LAST OPP EN VOGNLISTE PDF
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
