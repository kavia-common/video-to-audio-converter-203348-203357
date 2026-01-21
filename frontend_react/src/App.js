import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Configuration notes:
 * - This frontend expects a backend that can:
 *   1) Accept an MP4 upload and start a conversion job.
 *   2) Provide job status updates.
 *   3) Provide a downloadable MP3 when complete.
 *
 * Environment variables:
 * - REACT_APP_API_BASE or REACT_APP_BACKEND_URL: Base URL for HTTP API calls (e.g., https://api.example.com)
 * - REACT_APP_WS_URL: Optional WebSocket URL for real-time updates (falls back to polling)
 */

// PUBLIC_INTERFACE
function App() {
  const API_BASE = useMemo(() => {
    // Prefer REACT_APP_API_BASE; fall back to REACT_APP_BACKEND_URL.
    const fromEnv =
      process.env.REACT_APP_API_BASE || process.env.REACT_APP_BACKEND_URL || "";
    return fromEnv.replace(/\/+$/, "");
  }, []);

  const WS_URL = useMemo(() => {
    const fromEnv = process.env.REACT_APP_WS_URL || "";
    return fromEnv.replace(/\/+$/, "");
  }, []);

  const fileInputRef = useRef(null);

  const [selectedFile, setSelectedFile] = useState(null);

  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("idle"); // idle | uploading | converting | done | error
  const [statusText, setStatusText] = useState("Select an MP4 file to begin.");
  const [progressPct, setProgressPct] = useState(0);

  const [downloadUrl, setDownloadUrl] = useState("");
  const [errorText, setErrorText] = useState("");

  // Track timers / sockets so we can cleanly dispose.
  const pollTimerRef = useRef(null);
  const wsRef = useRef(null);

  const canStart = Boolean(selectedFile) && status !== "uploading" && status !== "converting";
  const canReset = status !== "uploading" && status !== "converting";

  const humanFileSize = (bytes) => {
    if (!bytes && bytes !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const disconnectWs = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (_) {
        // ignore
      }
      wsRef.current = null;
    }
  };

  const resetState = () => {
    stopPolling();
    disconnectWs();
    setJobId("");
    setStatus("idle");
    setStatusText("Select an MP4 file to begin.");
    setProgressPct(0);
    setDownloadUrl("");
    setErrorText("");
  };

  const isMp4 = (file) => {
    if (!file) return false;
    if (file.type === "video/mp4") return true;
    return file.name.toLowerCase().endsWith(".mp4");
  };

  const onPickFile = (file) => {
    setErrorText("");
    setDownloadUrl("");
    setJobId("");
    setProgressPct(0);

    if (!file) {
      setSelectedFile(null);
      setStatus("idle");
      setStatusText("Select an MP4 file to begin.");
      return;
    }

    if (!isMp4(file)) {
      setSelectedFile(null);
      setStatus("error");
      setStatusText("Invalid file type.");
      setErrorText("Please choose an .mp4 video file.");
      return;
    }

    setSelectedFile(file);
    setStatus("idle");
    setStatusText("Ready to convert.");
  };

  const onFileInputChange = (e) => {
    const f = e.target.files && e.target.files[0];
    onPickFile(f || null);
  };

  /**
   * Backend compatibility approach:
   * Since backend routes aren't provided in this task, we implement a tolerant strategy:
   * - Try POST {API_BASE}/api/convert with multipart {file}
   * - If that fails, try POST {API_BASE}/convert
   * Expected response (any of these forms):
   * - { jobId: "..." }
   * - { id: "..." }
   * - { job_id: "..." }
   * Optional:
   * - { downloadUrl: "..." } or { download_url: "..." }
   */
  const startConversion = async () => {
    if (!selectedFile) return;

    if (!API_BASE) {
      setStatus("error");
      setStatusText("Missing backend configuration.");
      setErrorText(
        "Set REACT_APP_API_BASE (or REACT_APP_BACKEND_URL) to your backend base URL."
      );
      return;
    }

    stopPolling();
    disconnectWs();
    setErrorText("");
    setDownloadUrl("");
    setStatus("uploading");
    setStatusText("Uploading MP4…");
    setProgressPct(8);

    const form = new FormData();
    form.append("file", selectedFile);

    const candidates = [`${API_BASE}/api/convert`, `${API_BASE}/convert`];

    let lastErr = null;
    let data = null;

    for (const url of candidates) {
      try {
        // We cannot reliably compute upload progress using fetch without extra libs.
        const res = await fetch(url, {
          method: "POST",
          body: form,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
        }

        data = await res.json().catch(() => ({}));
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (lastErr) {
      setStatus("error");
      setStatusText("Upload failed.");
      setProgressPct(0);
      setErrorText(
        `Could not start conversion. ${lastErr.message || "Please check backend connectivity."}`
      );
      return;
    }

    const id = data?.jobId || data?.id || data?.job_id || "";
    const dl = data?.downloadUrl || data?.download_url || "";

    if (!id && !dl) {
      // Backend might return a direct downloadUrl without job tracking; or something else.
      // We'll treat this as an error so the user isn't left hanging.
      setStatus("error");
      setStatusText("Unexpected backend response.");
      setProgressPct(0);
      setErrorText(
        "Backend did not return a job id or a download URL. Ensure the backend exposes a convert endpoint."
      );
      return;
    }

    if (dl) {
      setStatus("done");
      setStatusText("Conversion complete.");
      setProgressPct(100);
      setDownloadUrl(dl.startsWith("http") ? dl : `${API_BASE}${dl.startsWith("/") ? "" : "/"}${dl}`);
      return;
    }

    setJobId(id);
    setStatus("converting");
    setStatusText("Converting to MP3…");
    setProgressPct(18);

    // Prefer WebSocket if configured; otherwise use polling.
    if (WS_URL) {
      connectWsAndListen(id);
    } else {
      startPolling(id);
    }
  };

  /**
   * Polling status:
   * Try GET {API_BASE}/api/status/{jobId} then {API_BASE}/status/{jobId}
   * Expected response examples:
   * - { status: "processing" | "done" | "error", progress: 0..100, downloadUrl?: "..." }
   * - { state: "...", percent: 0..100, download_url?: "..." }
   */
  const fetchJobStatus = async (id) => {
    const candidates = [`${API_BASE}/api/status/${encodeURIComponent(id)}`, `${API_BASE}/status/${encodeURIComponent(id)}`];
    let lastErr = null;

    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
        }
        const data = await res.json().catch(() => ({}));
        return { data, error: null };
      } catch (err) {
        lastErr = err;
      }
    }

    return { data: null, error: lastErr || new Error("Unknown error") };
  };

  const normalizeStatus = (data) => {
    const raw = (data?.status || data?.state || "").toString().toLowerCase();
    if (["done", "completed", "complete", "success", "succeeded"].includes(raw)) return "done";
    if (["error", "failed", "failure"].includes(raw)) return "error";
    if (["processing", "converting", "running", "in_progress", "in-progress"].includes(raw)) return "converting";
    if (raw) return "converting";
    return "converting";
  };

  const extractProgress = (data) => {
    const v = data?.progress ?? data?.percent ?? data?.pct ?? null;
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    return null;
  };

  const extractDownloadUrl = (data) => {
    const dl = data?.downloadUrl || data?.download_url || data?.url || "";
    if (!dl) return "";
    return dl.startsWith("http") ? dl : `${API_BASE}${dl.startsWith("/") ? "" : "/"}${dl}`;
  };

  const startPolling = (id) => {
    stopPolling();
    pollTimerRef.current = window.setInterval(async () => {
      const { data, error } = await fetchJobStatus(id);

      if (error) {
        // Keep polling; transient errors happen.
        setStatusText("Still converting… (waiting for status)");
        return;
      }

      const st = normalizeStatus(data);
      const pct = extractProgress(data);
      const dl = extractDownloadUrl(data);

      if (pct !== null) setProgressPct(Math.max(18, pct));

      if (st === "done" || dl) {
        stopPolling();
        setStatus("done");
        setStatusText("Conversion complete.");
        setProgressPct(100);
        setDownloadUrl(dl || "");
        return;
      }

      if (st === "error") {
        stopPolling();
        setStatus("error");
        setStatusText("Conversion failed.");
        setProgressPct(0);
        setErrorText(data?.message || data?.error || "The backend reported an error during conversion.");
        return;
      }

      setStatus("converting");
      setStatusText("Converting to MP3…");
      if (pct === null) {
        // gentle “alive” progress
        setProgressPct((prev) => Math.min(92, Math.max(18, prev + 2)));
      }
    }, 1500);
  };

  /**
   * WebSocket listening:
   * Since backend WS event schema isn't specified, we implement a tolerant parser that accepts:
   * - JSON messages: { jobId, status/state, progress/percent, downloadUrl }
   * If parsing fails, we fall back to polling.
   */
  const connectWsAndListen = (id) => {
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        // Try to subscribe in a generic way (safe even if backend ignores).
        try {
          ws.send(JSON.stringify({ type: "subscribe", jobId: id }));
        } catch (_) {
          // ignore
        }
      };

      ws.onmessage = (evt) => {
        let msg = null;
        try {
          msg = JSON.parse(evt.data);
        } catch (_) {
          // Ignore non-JSON messages.
          return;
        }

        // If message is for different job, ignore (if jobId exists).
        if (msg?.jobId && msg.jobId !== id) return;

        const st = normalizeStatus(msg);
        const pct = extractProgress(msg);
        const dl = extractDownloadUrl(msg);

        if (pct !== null) setProgressPct(Math.max(18, pct));

        if (st === "done" || dl) {
          disconnectWs();
          stopPolling();
          setStatus("done");
          setStatusText("Conversion complete.");
          setProgressPct(100);
          setDownloadUrl(dl || "");
          return;
        }

        if (st === "error") {
          disconnectWs();
          stopPolling();
          setStatus("error");
          setStatusText("Conversion failed.");
          setProgressPct(0);
          setErrorText(msg?.message || msg?.error || "The backend reported an error during conversion.");
          return;
        }

        setStatus("converting");
        setStatusText("Converting to MP3…");
        if (pct === null) {
          setProgressPct((prev) => Math.min(92, Math.max(18, prev + 1)));
        }
      };

      ws.onerror = () => {
        // Fall back to polling if WS is not usable.
        disconnectWs();
        startPolling(id);
      };

      ws.onclose = () => {
        // If still converting, fall back to polling (unless already done/error).
        if (status === "converting") startPolling(id);
      };
    } catch (err) {
      startPolling(id);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
      disconnectWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusBadge = () => {
    if (status === "uploading") return { label: "Uploading", dotClass: "running" };
    if (status === "converting") return { label: "Converting", dotClass: "running" };
    if (status === "done") return { label: "Complete", dotClass: "done" };
    if (status === "error") return { label: "Error", dotClass: "error" };
    return { label: "Idle", dotClass: "" };
  };

  const badge = statusBadge();

  return (
    <div className="App">
      <div className="shell">
        <div className="topbar">
          <div className="topbar-inner">
            <div className="brand" aria-label="App header">
              <div className="brand-mark" aria-hidden="true" />
              <div className="brand-text">
                <div className="brand-title">Video → Audio Converter</div>
                <div className="brand-subtitle">Upload MP4, convert to MP3, download instantly</div>
              </div>
            </div>
            <div className="pill" title="Configuration">
              <span className="pill-dot" aria-hidden="true" />
              <span className="mono">
                API: {API_BASE ? new URL(API_BASE).host : "not set"}
              </span>
            </div>
          </div>
        </div>

        <main className="main">
          <div className="container">
            <div className="hero">
              <h1>Convert MP4 to MP3</h1>
              <p>
                A clean, single-page workflow: pick a video file, start conversion, and download the audio when ready.
              </p>
            </div>

            <section className="card" aria-label="MP4 upload and conversion">
              <div className="card-header">
                <div>
                  <h2>1) Upload your MP4</h2>
                  <small>We’ll extract the audio track and export an MP3.</small>
                </div>
                <div className="badge" aria-live="polite">
                  <span className={`badge-dot ${badge.dotClass}`} aria-hidden="true" />
                  <span>{badge.label}</span>
                </div>
              </div>

              <div className="card-body">
                <div className="dropzone">
                  <strong>Choose an MP4 file</strong>
                  <span>Supported: .mp4 (video/mp4). Larger files may take longer.</span>
                  <div style={{ marginTop: 12 }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/mp4,.mp4"
                      onChange={onFileInputChange}
                      aria-label="Select MP4 file"
                    />
                  </div>
                </div>

                {selectedFile && (
                  <div className="file-row" aria-label="Selected file">
                    <div className="file-meta">
                      <div className="file-name">{selectedFile.name}</div>
                      <div className="file-sub">
                        {humanFileSize(selectedFile.size)} • {selectedFile.type || "unknown mime"}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        if (fileInputRef.current) fileInputRef.current.value = "";
                        onPickFile(null);
                      }}
                      disabled={!canReset}
                    >
                      Clear
                    </button>
                  </div>
                )}

                <div className="actions" aria-label="Actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={startConversion}
                    disabled={!canStart}
                  >
                    Start conversion
                  </button>

                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={resetState}
                    disabled={!canReset}
                  >
                    Reset
                  </button>

                  {downloadUrl && (
                    <a
                      className="btn btn-primary"
                      href={downloadUrl}
                      download
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download MP3
                    </a>
                  )}
                </div>
              </div>

              <div className="status" aria-label="Conversion status">
                <div className="status-line">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>2) Status</div>
                    <div className="mono" aria-live="polite">
                      {statusText}
                      {jobId ? ` (job: ${jobId})` : ""}
                    </div>
                    {errorText ? (
                      <div style={{ marginTop: 6, color: "var(--error)", fontSize: 13 }}>
                        {errorText}
                      </div>
                    ) : null}
                  </div>
                  <div className="mono" aria-label="Progress percent">
                    {status === "uploading" || status === "converting" || status === "done"
                      ? `${Math.round(progressPct)}%`
                      : ""}
                  </div>
                </div>

                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPct)}>
                  <div style={{ width: `${Math.round(progressPct)}%` }} />
                </div>

                <div className="mono">
                  Tip: If you expect real-time status, set <strong>REACT_APP_WS_URL</strong>; otherwise the app will poll.
                </div>
              </div>
            </section>

            <div className="footer">
              Built with Ocean Professional styling (blue + amber), modern card layout, and accessible states.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
