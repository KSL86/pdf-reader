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
  { key: "page_number", label: "Side" },
  { key: "validation_status", label: "Status" },
  { key: "validation_errors", label: "Feil" },
];

const PAGES_PER_BATCH = 1;

function toCSV(rows) {
  const header = COLS.map((c) => c.label).join(";");

  const lines = rows.map((r) =>
    COLS.map((c) => {
      let value = r?.[c.key] ?? "";

      if (Array.isArray(value)) {
        value = value.join(" | ");
      } else if (typeof value === "object" && value !== null) {
        value = JSON.stringify(value);
      }

      const text = String(value).replace(/"/g, '""');
      return text.includes(";") || text.includes('"') || text.includes("\n")
        ? `"${text}"`
        : text;
    }).join(";")
  );

  return [header, ...lines].join("\n");
}

function downloadCSV(rows, filename = "battery_rows_staging.csv") {
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
    id: row?.id ?? null,
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
    page_number: row?.page_number ?? null,
    validation_status: row?.validation_status ?? "",
    validation_errors: Array.isArray(row?.validation_errors)
      ? row.validation_errors
      : row?.validation_errors ?? [],
    raw_model_output: row?.raw_model_output ?? "",
    fingerprint: row?.fingerprint ?? "",
    created_at: row?.created_at ?? "",
    updated_at: row?.updated_at ?? "",
  };
}

function dedupeRows(rows) {
  const seen = new Set();
  const result = [];

  for (const row of rows) {
    const normalized = normalizeRow(row);
    const key =
      normalized.fingerprint ||
      [
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
        normalized.page_number,
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

async function parseJsonResponse(resp, fallbackPrefix) {
  const raw = await resp.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${fallbackPrefix}. Svar startet med: ${raw.slice(0, 500)}`);
  }

  if (!resp.ok) {
    throw new Error(data?.error || `${fallbackPrefix} (${resp.status})`);
  }

  return data;
}

function renderValidationErrors(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join(" | ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function VognlisteExtractor() {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState("id");
  const [sortDir, setSortDir] = useState("asc");
  const [append, setAppend] = useState(false);
  const [loadingDb, setLoadingDb] = useState(true);
  const [isCancelling, setIsCancelling] = useState(false);

  const inputRef = useRef(null);
  const abortRef = useRef(null);

  const summary = useMemo(() => {
    const valid = rows.filter((r) => r.validation_status === "valid").length;
    const review = rows.filter((r) => r.validation_status !== "valid").length;
    return {
      total: rows.length,
      valid,
      review,
    };
  }, [rows]);

  const loadRowsFromDatabase = useCallback(async () => {
    try {
      setLoadingDb(true);
      setErrorMsg("");

      const resp = await fetch("/api/staging-rows");
      const data = await parseJsonResponse(resp, "Staging-kallet svarte ikke med JSON");

      const incomingRows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];
      setRows(dedupeRows(incomingRows));
    } catch (err) {
      setErrorMsg(err?.message || "Feil ved lasting fra staging");
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

  const saveRowsToStaging = useCallback(async (newRows) => {
    const resp = await fetch("/api/staging-rows", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rows: newRows,
      }),
    });

    const data = await parseJsonResponse(resp, "Lagring til staging svarte ikke med JSON");
    return {
      rows: Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [],
      validCount: data?.validCount ?? 0,
      reviewCount: data?.reviewCount ?? 0,
      insertedOrUpdated: data?.inserted_or_updated ?? 0,
    };
  }, []);

  const clearStaging = useCallback(async () => {
    const confirmed = window.confirm("Vil du slette alle rader fra staging-tabellen?");
    if (!confirmed) return;

    try {
      setStatus("loading");
      setProgress("Tømmer staging...");
      setErrorMsg("");
      setSuccessMsg("");

      const resp = await fetch("/api/staging-rows", {
        method: "DELETE",
      });

      await parseJsonResponse(resp, "Sletting svarte ikke med JSON");

      setRows([]);
      setStatus("done");
      setProgress("");
      setSuccessMsg("Staging-tabellen er tømt.");
    } catch (err) {
      setStatus("error");
      setProgress("");
      setErrorMsg(err?.message || "Feil ved tømming av staging");
    }
  }, []);

  const promoteValidRows = useCallback(async () => {
    try {
      setStatus("loading");
      setProgress("Flytter gyldige rader til final-tabell...");
      setErrorMsg("");
      setSuccessMsg("");

      const resp = await fetch("/api/promote-valid-rows", {
        method: "POST",
      });

      const data = await parseJsonResponse(resp, "Flytting svarte ikke med JSON");

      setStatus("done");
      setProgress("");
      setSuccessMsg(`${data.promoted || 0} gyldige rader flyttet til final-tabell.`);
    } catch (err) {
      setStatus("error");
      setProgress("");
      setErrorMsg(err?.message || "Feil ved flytting til final-tabell");
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
Svar KUN med en komplett JSON-array.
JSON må være gyldig og fullført.
Ikke bruk markdown.
Ikke bruk kodeblokker.
Ikke inkluder forklaringstekst.
Hvis ingen rader finnes, returner [].
Hvert objekt skal ha feltene:
bilmerke, modell, fra_aar, til_aar, motortype, ah, cca, dimensjon, polplassering, batteritype, varenummer.`;

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
            pageNumber: fromPage,
          }),
        });

        const data = await parseJsonResponse(resp, "Serveren svarte ikke med JSON");
        const batchRows = Array.isArray(data?.rows) ? data.rows.map(normalizeRow) : [];

        extractedRows = dedupeRows([...extractedRows, ...batchRows]);

        setRows((prev) => {
          if (append) {
            return dedupeRows([...prev, ...batchRows]);
          }
          return [...extractedRows];
        });
      }

      if (extractedRows.length === 0) {
        setStatus("done");
        setProgress("");
        setSuccessMsg("Ingen rader ble funnet i dokumentet.");
        return;
      }

      setProgress("Lagrer til staging...");
      const stagingResult = await saveRowsToStaging(extractedRows);

      await loadRowsFromDatabase();

      setStatus("done");
      setProgress("");
      setSuccessMsg(
        `${stagingResult.insertedOrUpdated} rader lagret/oppdatert i staging. ` +
          `${stagingResult.validCount} gyldige, ${stagingResult.reviewCount} til kontroll.`
      );
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
  }, [append, file, loadRowsFromDatabase, saveRowsToStaging]);

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
      Object.values(row).some((value) => {
        if (Array.isArray(value)) {
          return value.join(" ").toLowerCase().includes(q);
        }
        return String(value ?? "").toLowerCase().includes(q);
      })
    );
  }, [filter, rows]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];

    copy.sort((a, b) => {
      const av = a?.[sortKey];
      const bv = b?.[sortKey];

      const aVal = Array.isArray(av) ? av.join(" | ") : av ?? "";
      const bVal = Array.isArray(bv) ? bv.join(" | ") : bv ?? "";

      const result = String(aVal).localeCompare(String(bVal), "nb", { numeric: true });
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
          flexWrap: "wrap",
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
            STAGING + VALIDERING + FINAL
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
          <div className="panel" style={{ padding: "6px 12px", color: "#aaa", fontSize: "13px" }}>
            Staging: <span style={{ color: "#f5a623", fontWeight: 700 }}>{summary.total}</span>
          </div>
          <div className="panel" style={{ padding: "6px 12px", color: "#aaa", fontSize: "13px" }}>
            Valid: <span style={{ color: "#6ad17a", fontWeight: 700 }}>{summary.valid}</span>
          </div>
          <div className="panel" style={{ padding: "6px 12px", color: "#aaa", fontSize: "13px" }}>
            Review: <span style={{ color: "#ff8d8d", fontWeight: 700 }}>{summary.review}</span>
          </div>
          {loadingDb && <div style={{ fontSize: "12px", color: "#777" }}>Laster staging...</div>}
        </div>
      </div>

      <div style={{ padding: "24px", maxWidth: "1800px", margin: "0 auto" }}>
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
                  Ekstrahering går side for side til staging
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
              {status === "loading" ? "⏳ PROSESSERER..." : "▶ EKSTRAHER TIL STAGING"}
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
              Vis nye rader sammen med eksisterende staging-data under kjøring
            </label>

            <button
              className="btn btn-secondary"
              onClick={promoteValidRows}
              disabled={status === "loading" || summary.valid === 0}
            >
              ✓ FLYTT GYLDIGE TIL FINAL
            </button>

            {rows.length > 0 && (
              <button className="btn btn-secondary" onClick={() => downloadCSV(rows)}>
                ⬇ LAST NED STAGING CSV
              </button>
            )}

            <button className="btn btn-danger" onClick={clearStaging} disabled={status === "loading"}>
              🗑 TØM STAGING
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
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
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
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.label} {sortKey === c.key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => {
                    const isValid = r.validation_status === "valid";
                    return (
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

                        {COLS.map((c) => {
                          let displayValue = r?.[c.key];

                          if (c.key === "validation_errors") {
                            displayValue = renderValidationErrors(displayValue);
                          }

                          if (c.key === "validation_status") {
                            return (
                              <td
                                key={c.key}
                                style={{
                                  padding: "6px 10px",
                                  whiteSpace: "nowrap",
                                  color: isValid ? "#6ad17a" : "#ff8d8d",
                                  fontWeight: 600,
                                }}
                              >
                                {displayValue || "—"}
                              </td>
                            );
                          }

                          return (
                            <td
                              key={c.key}
                              style={{
                                padding: "6px 10px",
                                color:
                                  c.key === "bilmerke" || c.key === "modell"
                                    ? "#e8e0d0"
                                    : c.key === "ah" || c.key === "cca"
                                      ? "#f5a623"
                                      : c.key === "validation_errors"
                                        ? "#ff8d8d"
                                        : "#aaa",
                                whiteSpace: c.key === "validation_errors" ? "normal" : "nowrap",
                                maxWidth: c.key === "validation_errors" ? "320px" : "none",
                              }}
                            >
                              {displayValue || <span style={{ color: "#333" }}>—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rows.length === 0 && status !== "loading" && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#333" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px", opacity: 0.3 }}>🔋</div>
            <div style={{ fontSize: "13px", letterSpacing: ".1em" }}>
              INGEN STAGING-DATA ENNÅ — LAST OPP EN VOGNLISTE PDF
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
