import {
  createElement as h,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Fragment,
} from "react";
import { createRoot } from "react-dom/client";
import {
  flattenUtterances,
  categoryColor,
  followColor,
  makeSentenceKeyForEdit,
} from "./components.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function uid(u) {
  const t0 = Number(u.time_range?.[0] || 0);
  const t1 = Number(u.time_range?.[1] || 0);
  return `${t0.toFixed(2)}_${t1.toFixed(2)}_${(u.text || "").slice(0, 20)}`;
}

/** Single-leading-slash URL for repo-relative paths (normalizes Windows backslashes from API). */
function repoAssetUrl(relPath, cacheBust) {
  if (!relPath) return null;
  const norm = String(relPath).trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return null;
  const qs = cacheBust != null ? `?t=${cacheBust}` : "";
  return `/${norm}${qs}`;
}

const STATIC_CONFIG = window.WEB_VIZ_STATIC_CONFIG || {};
const IS_STATIC_MODE = Boolean(STATIC_CONFIG.enabled);

function cacheBustUrl(url, cacheBust) {
  if (cacheBust == null || !url) return url;
  const out = new URL(url, window.location.href);
  out.searchParams.set("t", String(cacheBust));
  return out.toString();
}

function staticDataIndexUrl(cacheBust) {
  return cacheBustUrl(STATIC_CONFIG.dataIndexUrl || "../sample_data/index.json", cacheBust);
}

function staticAssetUrl(path, baseUrl, cacheBust) {
  if (!path) return null;
  const url = new URL(String(path), baseUrl || staticDataIndexUrl()).toString();
  return cacheBustUrl(url, cacheBust);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readManifestObject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const hasV3 = Array.isArray(raw.conversations);
  const hasV2 = Array.isArray(raw.paragraphs) && raw.paragraphs.length > 0;
  const hasV1 = Array.isArray(raw.segments) && raw.segments.some((s) => Array.isArray(s.speech_annotations) && s.speech_annotations.length > 0);
  if (hasV3 || hasV2 || hasV1) return raw;
  return null;
}

function collectUniqueSpeakerLabels(manifest) {
  const seen = new Set();
  const out = [];
  for (const conv of manifest?.conversations || []) {
    for (const sent of conv?.sentences || []) {
      const speaker = String(sent?.speaker || "").trim();
      if (speaker && !seen.has(speaker)) {
        seen.add(speaker);
        out.push(speaker);
      }
    }
  }
  if (out.length > 0) return out;
  for (const par of manifest?.paragraphs || []) {
    for (const sent of par?.sentences || []) {
      const speaker = String(sent?.speaker || "").trim();
      if (speaker && !seen.has(speaker)) {
        seen.add(speaker);
        out.push(speaker);
      }
    }
  }
  if (out.length > 0) return out;
  for (const seg of manifest?.segments || []) {
    for (const ann of seg?.speech_annotations || []) {
      const speaker = String(ann?.speaker || "").trim();
      if (speaker && !seen.has(speaker)) {
        seen.add(speaker);
        out.push(speaker);
      }
    }
  }
  return out;
}

function normalizeSpeakerMapping(speakers, fallbackLabels = []) {
  const raw = speakers && typeof speakers === "object" ? speakers : {};
  const normalized = {
    "Speaker 1": fallbackLabels[0] || "blue_agent",
    "Speaker 2": fallbackLabels[1] || "Unknown",
  };
  if ("Speaker 1" in raw || "Speaker 2" in raw) {
    if (String(raw["Speaker 1"] || "").trim()) normalized["Speaker 1"] = String(raw["Speaker 1"]).trim();
    if (String(raw["Speaker 2"] || "").trim()) normalized["Speaker 2"] = String(raw["Speaker 2"]).trim();
    return normalized;
  }
  if ("Person 1" in raw || "Person 2" in raw) {
    if (String(raw["Person 1"] || "").trim()) normalized["Speaker 1"] = String(raw["Person 1"]).trim();
    if (String(raw["Person 2"] || "").trim()) normalized["Speaker 2"] = String(raw["Person 2"]).trim();
    return normalized;
  }
  return normalized;
}

function getSpeakerDisplayValues(speakers, fallbackLabels = []) {
  const normalized = normalizeSpeakerMapping(speakers, fallbackLabels);
  return {
    speaker1: normalized["Speaker 1"] || "blue_agent",
    speaker2: normalized["Speaker 2"] || "Unknown",
  };
}

const SENTENCE_SPEAKER_OPTIONS = ["blue_agent", "red_agent"];
const CONVERSATION_ROLE_OPTIONS = ["initiating_conversation", "response"];
const COMMUNICATION_FUNCTION_OPTIONS = [
  "request_action",
  "ask_information",
  "share_information",
  "suggest_plan",
  "promise",
  "acknowledge",
  "refuse",
  "clarify",
  "revise_plan",
];
const FOLLOW_LABEL_OPTIONS = ["follow", "unfollow", "unclear"];

function normalizeSentenceSpeaker(speaker) {
  const raw = String(speaker || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "red_agent" || lower === "red agent" || lower === "b" || lower === "speaker 2") {
    return "red_agent";
  }
  return "blue_agent";
}

function sentenceStart(sentence) {
  const range = sentence?.time_range || [0, 0];
  return Number(range[0] || 0);
}

function sentenceEnd(sentence) {
  const range = sentence?.time_range || [];
  return Number(range.length > 1 ? range[1] : range[0] || 0);
}

function normalizeStaticSentence(sentence, idx = 0, convId = "") {
  const start = sentenceStart(sentence);
  const end = sentenceEnd(sentence);
  const out = {
    speaker: normalizeSentenceSpeaker(sentence?.speaker),
    text: String(sentence?.text || "").trim(),
    time_range: [Number(start.toFixed(2)), Number(end.toFixed(2))],
    communication_category: String(sentence?.communication_category || "knowledge share").trim() || "knowledge share",
    conversation_role: String(sentence?.conversation_role || "initiating_conversation").trim() || "initiating_conversation",
    communication_function: String(sentence?.communication_function || "share_information").trim() || "share_information",
    success: String(sentence?.success || "unknown").trim() || "unknown",
    is_filler_like: Boolean(sentence?.is_filler_like),
    sentence_index: idx,
    conversation_id: convId,
  };
  if (convId) {
    out.speech_id = `${convId}_speech_${String(idx).padStart(3, "0")}`;
  } else if (sentence?.speech_id) {
    out.speech_id = sentence.speech_id;
  }
  return out;
}

function staticConversationBounds(sentences) {
  if (!sentences.length) return [0, 0];
  return [
    Number(Math.min(...sentences.map(sentenceStart)).toFixed(2)),
    Number(Math.max(...sentences.map(sentenceEnd)).toFixed(2)),
  ];
}

function renumberStaticConversations(conversations) {
  return (conversations || [])
    .filter((conv) => Array.isArray(conv?.sentences) && conv.sentences.length > 0)
    .map((conv, idx) => {
      const convId = `conv_${String(idx).padStart(3, "0")}`;
      const sentences = (conv.sentences || [])
        .filter((sent) => String(sent?.text || "").trim())
        .map((sent, sentIdx) => normalizeStaticSentence(sent, sentIdx, convId));
      const [start, end] = staticConversationBounds(sentences);
      return {
        ...conv,
        conversation_id: convId,
        time_range: [start, end],
        action_window: Array.isArray(conv.action_window) && conv.action_window.length >= 2
          ? [Number(conv.action_window[0] || start), Number(conv.action_window[1] || end)]
          : [start, Number((end + CLIP_TAIL_PAD_S).toFixed(2))],
        follow_label: conv.follow_label || "unclear",
        collapsed: Boolean(conv.collapsed),
        sentences,
      };
    });
}

function staticParagraphsFromConversations(conversations) {
  return (conversations || []).map((conv) => ({
    time_range: conv.time_range || staticConversationBounds(conv.sentences || []),
    action_window: conv.action_window,
    follow_label: conv.follow_label || "unclear",
    communication_category: conv.sentences?.[0]?.communication_category || "knowledge share",
    collapsed: Boolean(conv.collapsed),
    sentences: conv.sentences || [],
  }));
}

function mergeStaticConversationPair(first, second) {
  const sentences = [...(first.sentences || []), ...(second.sentences || [])]
    .map((sent) => normalizeStaticSentence(sent))
    .sort((a, b) => sentenceStart(a) - sentenceStart(b) || sentenceEnd(a) - sentenceEnd(b));
  const [start, end] = staticConversationBounds(sentences);
  const windows = [first.action_window, second.action_window].filter((w) => Array.isArray(w) && w.length >= 2);
  return {
    time_range: [start, end],
    action_window: windows.length
      ? [
          Number(Math.min(...windows.map((w) => Number(w[0] || 0))).toFixed(2)),
          Number(Math.max(...windows.map((w) => Number(w[1] || 0))).toFixed(2)),
        ]
      : [start, Number((end + CLIP_TAIL_PAD_S).toFixed(2))],
    follow_label: first.follow_label === second.follow_label ? first.follow_label || "unclear" : "unclear",
    collapsed: Boolean(first.collapsed && second.collapsed),
    sentences,
  };
}

function splitStaticConversationAt(conv, splitIndex) {
  const sentences = (conv.sentences || []).map((sent) => normalizeStaticSentence(sent));
  if (splitIndex <= 0 || splitIndex >= sentences.length) return [conv];
  const leftSentences = sentences.slice(0, splitIndex);
  const rightSentences = sentences.slice(splitIndex);
  const [leftStart, leftEnd] = staticConversationBounds(leftSentences);
  const [rightStart, rightEnd] = staticConversationBounds(rightSentences);
  return [
    {
      ...conv,
      time_range: [leftStart, leftEnd],
      action_window: [leftStart, Number((leftEnd + CLIP_TAIL_PAD_S).toFixed(2))],
      sentences: leftSentences,
    },
    {
      ...conv,
      time_range: [rightStart, rightEnd],
      action_window: [rightStart, Number((rightEnd + CLIP_TAIL_PAD_S).toFixed(2))],
      follow_label: "unclear",
      sentences: rightSentences,
    },
  ];
}

function applyStaticConversationPayload(manifest, editPayload) {
  const next = JSON.parse(JSON.stringify(manifest || {}));
  let conversations = Array.isArray(next.conversations) ? next.conversations : [];
  const edits = Array.isArray(editPayload?.conversation_edits) ? editPayload.conversation_edits : [];

  for (const edit of edits) {
    const idx = conversations.findIndex((conv, convIdx) =>
      (edit.conversation_id && conv.conversation_id === edit.conversation_id) ||
      Number(edit.conversation_index) === convIdx
    );
    if (idx < 0) continue;
    const conv = { ...conversations[idx] };
    if ("follow_label" in edit) conv.follow_label = edit.follow_label || "unclear";
    if ("collapsed" in edit) conv.collapsed = Boolean(edit.collapsed);
    if (Array.isArray(edit.action_window) && edit.action_window.length >= 2) {
      conv.action_window = [Number(edit.action_window[0] || 0), Number(edit.action_window[1] || 0)];
    }
    if (Array.isArray(edit.edited_sentences)) {
      conv.sentences = edit.edited_sentences
        .filter((sent) => String(sent?.text || "").trim())
        .map((sent, sentIdx) => normalizeStaticSentence(sent, sentIdx, conv.conversation_id || ""));
    }
    conversations[idx] = conv;
  }

  for (const op of editPayload?.conversation_ops || []) {
    const idx = Number(op?.conversation_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= conversations.length) continue;
    const kind = String(op?.type || op?.op || "").toLowerCase();
    if (kind === "merge") {
      const targetIdx = "target_index" in op
        ? Number(op.target_index)
        : String(op.direction || "next").toLowerCase() === "previous"
          ? idx - 1
          : idx + 1;
      if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= conversations.length || Math.abs(targetIdx - idx) !== 1) {
        continue;
      }
      const firstIdx = Math.min(idx, targetIdx);
      const secondIdx = Math.max(idx, targetIdx);
      conversations = [
        ...conversations.slice(0, firstIdx),
        mergeStaticConversationPair(conversations[firstIdx], conversations[secondIdx]),
        ...conversations.slice(secondIdx + 1),
      ];
      continue;
    }
    if (kind === "split") {
      const splitIndex = Number(op.sentence_index);
      if (!Number.isInteger(splitIndex)) continue;
      conversations = [
        ...conversations.slice(0, idx),
        ...splitStaticConversationAt(conversations[idx], splitIndex),
        ...conversations.slice(idx + 1),
      ];
    }
  }

  next.conversations = renumberStaticConversations(conversations);
  next.paragraphs = staticParagraphsFromConversations(next.conversations);
  return next;
}

function canonicalSessionStem(name) {
  let stem = String(name || "").replace(/\.[^.]+$/, "");
  while (stem.endsWith("_labeled")) {
    stem = stem.slice(0, -"_labeled".length);
  }
  if (stem.endsWith("_speech")) {
    stem = stem.slice(0, -"_speech".length);
  }
  return stem;
}

function detectSessionStem(files) {
  const trajectories = Array.from(files || [])
    .map((f) => f.name || "")
    .filter((name) => /\.json$/i.test(name))
    .filter((name) => {
      const stem = name.replace(/\.json$/i, "");
      return !stem.endsWith("_speech") && !stem.endsWith("_labeled");
    });
  if (trajectories.length !== 1) return "";
  return trajectories[0].replace(/\.json$/i, "");
}

const CLIP_TAIL_PAD_S = 5;

function clipRangeForItem(item) {
  const hasActionWindow = Array.isArray(item?.action_window) && item.action_window.length >= 2;
  const preferredRange =
    hasActionWindow
      ? item.action_window
      : item?.time_range || [];
  const start = Number(preferredRange?.[0] || 0);
  const end = Number(preferredRange?.[1] || start);
  return {
    start,
    end: Math.max(start, hasActionWindow ? end || start : (end || start) + CLIP_TAIL_PAD_S),
  };
}

/** Read fetch() response body as JSON; surface HTML error pages as a clear message. */
async function readResponseJson(resp, urlLabel) {
  const text = await resp.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype")) {
    throw new Error(
      `Server returned HTML instead of JSON for ${urlLabel} (HTTP ${resp.status}). ` +
        `Use the repo visualization server from the project root and restart it after updates: ` +
        `PYTHONPATH=. python scripts/web_visualization_server.py`
    );
  }
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON from ${urlLabel}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function SessionUpload({ onSubmit, onError, disabled }) {
  const folderRef = useRef(null);
  return h(
    "section",
    { className: "pipeline-panel" },
    h("h2", null, "Run pipeline"),
    h(
      "div",
      { className: "pipeline-row" },
      h(
        "div",
        { className: "pipeline-option-info" },
        h("div", { className: "pipeline-option-title" }, "Option 1"),
        h("p", null, "Upload a folder containing trajectory file and audio file.")
      ),
      h(
        "div",
        { className: "pipeline-option-controls" },
        h(
          "label",
          { className: "file-picker" },
          h("span", null, "map_timestamp folder"),
          h("input", {
            type: "file",
            ref: folderRef,
            disabled,
            multiple: true,
            webkitdirectory: "",
          })
        ),
        h(
          "button",
          {
            type: "button",
            disabled,
            onClick: () => onSubmit(Array.from(folderRef.current?.files || []), null),
          },
          disabled ? "Running..." : "Run pipeline"
        )
      )
    ),
    h(SessionDatasetUpload, { onSubmit, onError, disabled })
  );
}

function SessionDatasetUpload({ onSubmit, onError, disabled }) {
  const datasetRef = useRef(null);
  const speechRef = useRef(null);

  const handleSubmit = () => {
    const datasetFiles = Array.from(datasetRef.current?.files || []);
    const speechFile = speechRef.current?.files?.[0];
    if (!speechFile) {
      throw new Error("Provide speech_path (.json).");
    }
    if (!datasetFiles.length) {
      throw new Error("Provide a dataset folder.");
    }
    const stem = detectSessionStem(datasetFiles);
    if (!stem) {
      throw new Error("Could not find <map>_<timestamp>.json in the selected folder.");
    }
    const speechStem = canonicalSessionStem(speechFile.name);
    if (speechStem !== stem) {
      throw new Error(`speech_path basename (${speechStem}) must match ${stem}.`);
    }
    onSubmit(datasetFiles, speechFile);
  };

  return h(
    "div",
    { className: "pipeline-row pipeline-row-secondary" },
    h(
      "div",
      { className: "pipeline-option-info" },
      h("div", { className: "pipeline-option-title" }, "Option 2"),
      h("p", null, "Upload a folder containing trajectory file and audio file, plus an external speech file.")
    ),
    h(
      "div",
      { className: "pipeline-option-controls" },
      h(
        "label",
        { className: "file-picker" },
        h("span", null, "map_timestamp folder"),
        h("input", {
          type: "file",
          ref: datasetRef,
          disabled,
          multiple: true,
          webkitdirectory: "",
        })
      ),
      h(
        "label",
        { className: "file-picker" },
        h("span", null, "speech_path (.json)"),
        h("input", {
          type: "file",
          accept: ".json,application/json",
          ref: speechRef,
          disabled,
        })
      ),
      h(
        "button",
        {
          type: "button",
          disabled,
          onClick: () => {
            try {
              handleSubmit();
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
          },
        },
        disabled ? "Running..." : "Run pipeline"
      )
    )
  );
}

function StaticSessionPicker({ sessions, selectedId, onSelect }) {
  if (!IS_STATIC_MODE) return null;
  return h(
    "section",
    { className: "pipeline-panel" },
    h("h2", null, "Sample sessions"),
    sessions.length
      ? h(
          "div",
          { className: "pipeline-row" },
          h(
            "div",
            { className: "pipeline-option-info" },
            h("div", { className: "pipeline-option-title" }, "GitHub Pages static mode"),
            h("p", null, "Select a sample session. Edits stay in the browser until you download the JSON.")
          ),
          h(
            "div",
            { className: "pipeline-option-controls" },
            h(
              "select",
              {
                value: selectedId || "",
                onChange: (e) => onSelect(e.target.value),
              },
              sessions.map((session) =>
                h("option", { key: session.id, value: session.id }, session.label || session.id)
              )
            )
          )
        )
      : h("p", null, "No published sessions yet.")
  );
}

function SessionVideo({ src, onMediaError }) {
  if (!src) return null;
  return h(
    "section",
    { className: "video-panel" },
    h("h2", null, "Full session replay"),
    h(
      "div",
      { className: "video-wrap" },
      h("video", {
        key: src,
        className: "session-video",
        src,
        type: "video/mp4",
        controls: true,
        preload: "metadata",
        playsInline: true,
        onError: (e) => {
          if (!onMediaError) return;
          const el = e.target;
          const code = el && el.error ? el.error.code : 0;
          const msg =
            code === 4
              ? "Replay is not H.264 (ffmpeg did not run or failed). Delete web_visualization/generated/*.mp4, fix ffmpeg on PATH with libx264, restart the server, then re-run the pipeline."
              : "Could not load replay video (check the browser Network tab for the MP4 request).";
          onMediaError(msg);
        },
      })
    )
  );
}

function SpeakerIdentification({ speakers, fallbackLabels, onSave, disabled }) {
  const initialValues = getSpeakerDisplayValues(speakers, fallbackLabels);
  const [speaker1, setSpeaker1] = useState(() => initialValues.speaker1);
  const [speaker2, setSpeaker2] = useState(() => initialValues.speaker2);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    const nextValues = getSpeakerDisplayValues(speakers, fallbackLabels);
    setSpeaker1(nextValues.speaker1);
    setSpeaker2(nextValues.speaker2);
  }, [speakers, fallbackLabels]);

  const save = async () => {
    const nextSpeakers = {
      "Speaker 1": speaker1 || "blue_agent",
      "Speaker 2": speaker2 || "Unknown",
    };
    const ok = await onSave(nextSpeakers);
    if (ok) {
      setIsEditing(false);
    }
  };

  const reset = () => {
    setSpeaker1("blue_agent");
    setSpeaker2(fallbackLabels.length > 1 ? "red_agent" : "Unknown");
  };

  return h(
    "section",
    { className: "speaker-panel" },
    h("h2", null, "Speaker Identification"),
    isEditing
      ? h(
          "div",
          { className: "speaker-edit" },
          h(
            "label",
            null,
            "Speaker 1: ",
            h("input", {
              type: "text",
              value: speaker1,
              onChange: (e) => setSpeaker1(e.target.value),
              placeholder: "Name",
              disabled,
            })
          ),
          h(
            "label",
            null,
            "Speaker 2: ",
            h("input", {
              type: "text",
              value: speaker2,
              onChange: (e) => setSpeaker2(e.target.value),
              placeholder: "Name",
              disabled,
            })
          ),
          h(
            "div",
            { className: "speaker-actions" },
            h("button", { type: "button", onClick: save, className: "btn-primary", disabled }, "Save"),
            h("button", { type: "button", onClick: reset, className: "btn-secondary" }, "Reset")
          )
        )
      : h(
          "div",
          { className: "speaker-display" },
          h("div", null, h("strong", null, "Speaker 1: "), speaker1),
          h("div", null, h("strong", null, "Speaker 2: "), speaker2),
          h(
            "button",
            {
              type: "button",
              onClick: () => setIsEditing(true),
              className: "btn-secondary",
              disabled,
            },
            "Edit"
          )
        )
  );
}

function SegmentClipVideo({ src, t0, t1 }) {
  const ref = useRef(null);
  const userControlledPlaybackRef = useRef(false);
  const programmaticSeekRef = useRef(false);
  useEffect(() => {
    const v = ref.current;
    if (!v || !src) return undefined;
    userControlledPlaybackRef.current = false;
    programmaticSeekRef.current = false;
    const lo = Number(t0) || 0;
    const rawHi = Math.max(lo + 0.05, Number(t1) || lo);
    const getHi = () => {
      const duration = Number(v.duration);
      if (Number.isFinite(duration) && duration > 0) {
        return Math.max(lo + 0.05, Math.min(rawHi, duration));
      }
      return rawHi;
    };
    const onTimeUpdate = () => {
      if (userControlledPlaybackRef.current || v.seeking) return;
      const hi = getHi();
      if (v.currentTime >= hi - 0.04) v.currentTime = lo;
    };
    const onLoadedMetadata = () => {
      if (!userControlledPlaybackRef.current) {
        programmaticSeekRef.current = true;
        v.currentTime = lo;
        window.setTimeout(() => {
          programmaticSeekRef.current = false;
        }, 0);
      }
    };
    const onSeeking = () => {
      if (programmaticSeekRef.current) return;
      userControlledPlaybackRef.current = true;
    };
    const onUserControl = () => {
      userControlledPlaybackRef.current = true;
    };
    const onSeeked = () => {
      programmaticSeekRef.current = false;
    };
    v.addEventListener("pointerdown", onUserControl);
    v.addEventListener("mousedown", onUserControl);
    v.addEventListener("touchstart", onUserControl);
    v.addEventListener("keydown", onUserControl);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      v.removeEventListener("pointerdown", onUserControl);
      v.removeEventListener("mousedown", onUserControl);
      v.removeEventListener("touchstart", onUserControl);
      v.removeEventListener("keydown", onUserControl);
      v.removeEventListener("seeking", onSeeking);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [src, t0, t1]);

  return h("video", {
    key: `${src}_${t0}_${t1}`,
    ref,
    src,
    type: "video/mp4",
    controls: true,
    className: "segment-video",
    preload: "metadata",
    muted: true,
    playsInline: true,
    onClick: (e) => e.stopPropagation(),
    onMouseDown: (e) => {
      userControlledPlaybackRef.current = true;
      e.stopPropagation();
    },
    onPointerDown: (e) => {
      userControlledPlaybackRef.current = true;
      e.stopPropagation();
    },
  });
}

function SegmentList({ videoSrc, items, collapsedCount, totalCount, onSelect }) {
  const [expandedCollapsed, setExpandedCollapsed] = useState(() => new Set());

  const toggleCollapsed = useCallback((id) => {
    setExpandedCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (!videoSrc) return h("p", { className: "empty" }, "Run pipeline to generate replay + segments.");

  if (!items.length) {
    return h(
      "p",
      { className: "empty" },
      `No conversation episodes available. (total=${totalCount}, collapsed=${collapsedCount})`
    );
  }

  return h(
    "div",
    { className: "segment-list" },
    items.map((u) => {
      const id = uid(u);
      const t0 = Number(u.time_range?.[0] || 0);
      const t1 = Number(u.time_range?.[1] || 0);
      const clipRange = clipRangeForItem(u);
      const isCollapsed = Boolean(u.collapsed);
      const isExpanded = !isCollapsed || expandedCollapsed.has(id);
      const actionWindow = u.action_window || [t0, t1 + 5];
      const roleText = (u.conversation_roles || []).join(", ") || "unknown";
      const functionText = (u.communication_functions || []).join(", ") || "unknown";
      return h(
        "article",
        {
          key: id,
          className: `segment-card ${isCollapsed ? "conversation-collapsed" : ""}`,
          onClick: () => onSelect && onSelect(u),
        },
        h("div", { className: "segment-time" }, `${t0.toFixed(1)}s - ${t1.toFixed(1)}s`),
        h(
          "div",
          { className: "speaker-badge" },
          u.speaker || "?"
        ),
        h(
          "div",
          { className: "badge", style: { background: followColor(u.follow_label) } },
          u.follow_label || "unclear"
        ),
        h(
          "div",
          { className: "segment-time" },
          `action ${Number(actionWindow[0] || 0).toFixed(1)}s - ${Number(actionWindow[1] || 0).toFixed(1)}s`
        ),
        h(
          "div",
          { className: "badge", style: { background: categoryColor(u.communication_category) } },
          functionText
        ),
        h("div", { className: "meta" }, `role: ${roleText}`),
        isCollapsed &&
          h(
            "button",
            {
              type: "button",
              className: "conversation-toggle",
              onClick: (ev) => {
                ev.stopPropagation();
                toggleCollapsed(id);
              },
            },
            isExpanded ? "Collapse response" : "Expand response"
          ),
        isExpanded
          ? h(Fragment, null,
              h(SegmentClipVideo, { src: videoSrc, t0: clipRange.start, t1: clipRange.end }),
              h("p", { className: "segment-transcript" }, String(u.text || "")))
          : h("p", { className: "segment-transcript collapsed-text" }, "Response-only conversation collapsed by default.")
      );
    })
  );
}

function sentenceRowId(seed, idx) {
  return `${seed}_${idx}_${Math.random().toString(36).slice(2, 8)}`;
}

function allocateRangesByText(parts, start, end) {
  const s = Number(start || 0);
  const e = Number(end || s);
  const span = Math.max(0.01, e - s);
  const totalChars = Math.max(1, parts.reduce((acc, p) => acc + Math.max(1, p.length), 0));
  let cursor = s;
  return parts.map((p, idx) => {
    if (idx === parts.length - 1) {
      return [Number(cursor.toFixed(2)), Number(e.toFixed(2))];
    }
    const ratio = Math.max(1, p.length) / totalChars;
    const next = cursor + span * ratio;
    const out = [Number(cursor.toFixed(2)), Number(next.toFixed(2))];
    cursor = next;
    return out;
  });
}

function ParagraphEditor({ item, onClose, onSave, onRefine, videoSrc }) {
  const [followLabel, setFollowLabel] = useState(item.follow_label || "unclear");
  const [actionWindow, setActionWindow] = useState(() => {
    const aw = item.action_window || [item.time_range?.[0] || 0, (item.time_range?.[1] || 0) + 5];
    return [Number(aw[0] || 0), Number(aw[1] || 0)];
  });
  const [collapsed, setCollapsed] = useState(Boolean(item.collapsed));
  const [localEdits, setLocalEdits] = useState(() =>
    (item.sentences || []).map((s, idx) => {
      const speaker = normalizeSentenceSpeaker(s.speaker);
      return {
        row_id: sentenceRowId(item.paragraph_index, idx),
        paragraph_index: item.paragraph_index,
        conversation_index: item.conversation_index ?? item.paragraph_index,
        conversation_id: item.conversation_id || "",
        sentence_index: idx,
        sentence_key: makeSentenceKeyForEdit(s.time_range, speaker, s.text),
        original_sentence_key: makeSentenceKeyForEdit(s.time_range, s.speaker, s.text),
        original_label: s.communication_category || "",
        new_label: s.communication_category || "",
        original_success: s.success || "unknown",
        new_success: s.success || "unknown",
        conversation_role: s.conversation_role || "initiating_conversation",
        communication_function: s.communication_function || "share_information",
        speaker,
        text: s.text || "",
        time_range: s.time_range || [],
      };
    })
  );
  const [refining, setRefining] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [cursorByRowId, setCursorByRowId] = useState({});
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState([]);
  const speakerOptions = SENTENCE_SPEAKER_OPTIONS;

  const clipRange = clipRangeForItem(item);
  const t0 = clipRange.start;
  const t1 = clipRange.end;
  const hasInitiatingRole = localEdits.some(
    (e) => e.conversation_role === "initiating_conversation"
  );

  const updateConversationRole = (idx, value) => {
    setLocalEdits((prev) => {
      const next = prev.map((e, i) => (i === idx ? { ...e, conversation_role: value } : e));
      if (next.some((e) => e.conversation_role === "initiating_conversation")) {
        setCollapsed(false);
      }
      return next;
    });
  };

  const updateCommunicationFunction = (idx, value) => {
    setLocalEdits((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, communication_function: value } : e))
    );
  };

  const updateText = (idx, value) => {
    setLocalEdits((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, text: value } : e))
    );
  };

  const updateSpeaker = (idx, value) => {
    const nextSpeaker = normalizeSentenceSpeaker(value);
    setLocalEdits((prev) =>
      prev.map((e, i) =>
        i === idx
          ? {
              ...e,
              speaker: nextSpeaker,
              sentence_key: makeSentenceKeyForEdit(e.time_range, nextSpeaker, e.text),
            }
          : e
      )
    );
  };

  const splitRowAtCursor = (idx) => {
    setLocalEdits((prev) => {
      const row = prev[idx];
      if (!row) return prev;
      const text = String(row.text || "");
      const cursor = cursorByRowId[row.row_id];
      if (typeof cursor !== "number" || Number.isNaN(cursor)) {
        setEditorError("Place the cursor where you want to split, then click Split.");
        return prev;
      }
      if (cursor <= 0 || cursor >= text.length) {
        setEditorError("Cursor must be inside the sentence (not at the very start or end).");
        return prev;
      }
      const left = text.slice(0, cursor).trim();
      const right = text.slice(cursor).trim();
      if (!left || !right) {
        setEditorError("Split would create an empty sentence. Move cursor and try again.");
        return prev;
      }
      setEditorError("");
      const parts = [left, right];
      const start = Number(row.time_range?.[0] || 0);
      const end = Number(row.time_range?.[1] || start);
      const ranges = allocateRangesByText(parts, start, end);
      const expanded = parts.map((part, partIdx) => ({
        ...row,
        row_id: sentenceRowId(row.row_id, partIdx),
        sentence_index: idx + partIdx,
        text: part,
        time_range: ranges[partIdx],
      }));
      return [...prev.slice(0, idx), ...expanded, ...prev.slice(idx + 1)];
    });
  };

  const toggleMergeSelection = (idx) => {
    if (!mergeMode) return;
    setMergeSelection((prev) => {
      if (prev.includes(idx)) {
        return prev.filter((i) => i !== idx);
      }
      if (prev.length >= 2) {
        return [prev[1], idx];
      }
      return [...prev, idx];
    });
  };

  const mergeSelected = () => {
    setLocalEdits((prev) => {
      if (mergeSelection.length !== 2) {
        setEditorError("Select exactly two sentences to merge.");
        return prev;
      }
      const [i0, i1] = [...mergeSelection].sort((a, b) => a - b);
      if (i0 < 0 || i1 < 0 || i0 >= prev.length || i1 >= prev.length || i0 === i1) {
        setEditorError("Please select two valid sentences.");
        return prev;
      }
      const a = prev[i0];
      const b = prev[i1];
      const merged = {
        ...a,
        row_id: sentenceRowId(a.row_id, i0),
        speaker: normalizeSentenceSpeaker(a.speaker),
        text: `${String(a.text || "").trim()} ${String(b.text || "").trim()}`.trim(),
        time_range: [
          Number(Math.min(Number(a.time_range?.[0] || 0), Number(b.time_range?.[0] || 0)).toFixed(2)),
          Number(Math.max(Number(a.time_range?.[1] || 0), Number(b.time_range?.[1] || 0)).toFixed(2)),
        ],
      };
      const out = prev.filter((_, i) => i !== i0 && i !== i1);
      out.splice(i0, 0, merged);
      setMergeSelection([]);
      setMergeMode(false);
      setEditorError("");
      return out;
    });
  };

  const refineWithWhisper = async () => {
    if (!onRefine) return;
    setRefining(true);
    try {
      const refined = await onRefine({
        conversation_index: item.conversation_index ?? item.paragraph_index,
        edited_sentences: localEdits.map((e) => ({
          sentence_key: e.sentence_key,
          original_sentence_key: e.original_sentence_key || e.sentence_key,
          speaker: e.speaker || "",
          text: String(e.text || "").trim(),
          communication_category: e.new_label,
          conversation_role: e.conversation_role,
          communication_function: e.communication_function,
          success: e.new_success,
          time_range: e.time_range || [],
        })),
      });
      if (Array.isArray(refined) && refined.length === localEdits.length) {
        setLocalEdits((prev) =>
          prev.map((e, i) => ({
            ...e,
            time_range: Array.isArray(refined[i]?.time_range) ? refined[i].time_range : e.time_range,
          }))
        );
      }
    } finally {
      setRefining(false);
    }
  };

  const buildConversationEditPayload = () => {
    const cleaned = localEdits.map((e) => ({
      ...e,
      speaker: normalizeSentenceSpeaker(e.speaker),
      text: String(e.text || "").trim(),
    }));
    if (cleaned.some((e) => !e.text)) {
      setEditorError("Each sentence must have non-empty text.");
      return;
    }
    if (cleaned.some((e) => !String(e.speaker || "").trim())) {
      setEditorError("Each sentence must have a speaker. Choose blue_agent or red_agent.");
      return;
    }
    if (
      cleaned.some((e) => {
        const start = Number(e.time_range?.[0] ?? 0);
        const end = Number(e.time_range?.[1] ?? start);
        return Number.isNaN(start) || Number.isNaN(end) || end < start;
      })
    ) {
      setEditorError("All sentence time ranges must be valid and end >= start.");
      return;
    }
    if (
      Number.isNaN(Number(actionWindow[0])) ||
      Number.isNaN(Number(actionWindow[1])) ||
      Number(actionWindow[1]) < Number(actionWindow[0])
    ) {
      setEditorError("Action window must be valid and end >= start.");
      return null;
    }
    setEditorError("");
    const conversationEdit = {
      conversation_index: item.conversation_index ?? item.paragraph_index,
      conversation_id: item.conversation_id || "",
      follow_label: followLabel,
      action_window: actionWindow,
      collapsed: hasInitiatingRole ? false : collapsed,
      edited_sentences: cleaned.map((e, idx) => ({
        sentence_index: idx,
        sentence_key: e.sentence_key,
        original_sentence_key: e.original_sentence_key || e.sentence_key,
        speaker: e.speaker || "",
        text: e.text,
        communication_category: e.new_label,
        conversation_role: e.conversation_role,
        communication_function: e.communication_function,
        success: e.new_success,
        time_range: e.time_range || [],
      })),
    };
    return { cleaned, conversationEdit };
  };

  const runStructureOp = (op) => {
    const payload = buildConversationEditPayload();
    if (!payload) return;
    onSave({
      conversation_edits: [payload.conversationEdit],
      conversation_ops: [
        {
          conversation_index: item.conversation_index ?? item.paragraph_index,
          ...op,
        },
      ],
      edits: [],
      sentence_edits: [],
    });
  };

  const save = () => {
    const payload = buildConversationEditPayload();
    if (!payload) return;
    const { cleaned, conversationEdit } = payload;
    onSave({
      conversation_edits: [conversationEdit],
      edits: cleaned
        .filter(
          (e) =>
            e.new_label !== e.original_label ||
            e.new_success !== e.original_success
        )
        .map((e) => ({
          paragraph_index: e.paragraph_index,
          sentence_index: e.sentence_index,
          sentence_key: e.sentence_key,
          original_sentence_key: e.original_sentence_key || e.sentence_key,
          new_label: e.new_label,
          new_success: e.new_success,
        })),
      sentence_edits: [
        {
          paragraph_index: item.paragraph_index,
          edited_sentences: cleaned.map((e, idx) => ({
            sentence_index: idx,
            sentence_key: e.sentence_key,
            original_sentence_key: e.original_sentence_key || e.sentence_key,
            speaker: e.speaker || "",
            text: e.text,
            communication_category: e.new_label,
            conversation_role: e.conversation_role,
            communication_function: e.communication_function,
            success: e.new_success,
            time_range: e.time_range || [],
          })),
        },
      ],
    });
  };

  return h(
    Fragment,
    null,
    h(
      "section",
      { className: "video-panel" },
      h("h2", null, `Action window (${t0.toFixed(1)}s - ${t1.toFixed(1)}s)`),
      h(
        "div",
        { className: "video-wrap" },
        h(SegmentClipVideo, { src: videoSrc, t0, t1 })
      )
    ),
    h(
      "section",
      { className: "editor-panel" },
      h(
        "div",
        { className: "editor-header" },
        h("h2", { style: { margin: 0 } }, "Edit conversation episode"),
        h(
          "div",
          { className: "editor-header-actions" },
          h(
            "button",
            {
              type: "button",
              className: "btn-secondary",
              onClick: () => runStructureOp({ type: "merge", direction: "previous" }),
              disabled: !item.has_previous,
            },
            "Merge previous"
          ),
          h(
            "button",
            {
              type: "button",
              className: "btn-secondary",
              onClick: () => runStructureOp({ type: "merge", direction: "next" }),
              disabled: !item.has_next,
            },
            "Merge next"
          ),
          h(
            "button",
            {
              type: "button",
              className: "btn-secondary",
              onClick: refineWithWhisper,
              disabled: refining,
            },
            refining ? "Refining..." : "Refine with Whisper"
          ),
          h(
            "button",
            { type: "button", onClick: onClose, className: "back-button" },
            "< Back to all episodes"
          )
        )
      ),
      h(
        "div",
        { className: "conversation-controls" },
        h(
          "label",
          null,
          "Follow",
          h(
            "select",
            {
              value: followLabel,
              onChange: (ev) => setFollowLabel(ev.target.value),
            },
            FOLLOW_LABEL_OPTIONS.map((value) => h("option", { key: value, value }, value))
          )
        ),
        h(
          "label",
          null,
          "Action start",
          h("input", {
            type: "number",
            step: "0.01",
            value: actionWindow[0],
            onChange: (ev) =>
              setActionWindow(([_, end]) => [Number(ev.target.value || 0), end]),
          })
        ),
        h(
          "label",
          null,
          "Action end",
          h("input", {
            type: "number",
            step: "0.01",
            value: actionWindow[1],
            onChange: (ev) =>
              setActionWindow(([start]) => [start, Number(ev.target.value || 0)]),
          })
        ),
        h(
          "label",
          { className: "checkbox-label" },
          h("input", {
            type: "checkbox",
            checked: hasInitiatingRole ? false : collapsed,
            disabled: hasInitiatingRole,
            onChange: (ev) => setCollapsed(ev.target.checked),
          }),
          "Collapsed"
        )
      ),
      h(
        "div",
        { className: "editor-body" },
        localEdits.map((e, idx) =>
          h(
            "div",
            { key: e.row_id, className: "editor-row" },
            h(
              "div",
              { className: "editor-text" },
              h("span", { className: "speaker-tag" }, e.speaker || "?"),
              ` [${(e.time_range[0] ?? 0).toFixed(2)}-${(e.time_range[1] ?? 0).toFixed(2)}] `,
              h(
                "div",
                { className: "editor-inline-controls" },
                h("label", { className: "editor-inline-label" }, "Speaker"),
                h(
                  "select",
                  {
                    className: "speaker-select",
                    value: normalizeSentenceSpeaker(e.speaker),
                    onChange: (ev) => updateSpeaker(idx, ev.target.value),
                  },
                  speakerOptions.map((sp) => h("option", { key: sp, value: sp }, sp))
                )
              ),
              h("textarea", {
                className: "editor-text-input",
                value: e.text,
                rows: 2,
                onClick: (ev) =>
                  setCursorByRowId((prev) => ({ ...prev, [e.row_id]: ev.target.selectionStart })),
                onKeyUp: (ev) =>
                  setCursorByRowId((prev) => ({ ...prev, [e.row_id]: ev.target.selectionStart })),
                onSelect: (ev) =>
                  setCursorByRowId((prev) => ({ ...prev, [e.row_id]: ev.target.selectionStart })),
                onChange: (ev) => updateText(idx, ev.target.value),
              }),
              h(
                "div",
                { className: "editor-row-actions" },
                mergeMode &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: `btn-secondary ${mergeSelection.includes(idx) ? "is-selected" : ""}`,
                      onClick: () => toggleMergeSelection(idx),
                    },
                    mergeSelection.includes(idx) ? "Selected for merge" : "Select for merge"
                  ),
                h(
                  "button",
                  { type: "button", className: "btn-secondary", onClick: () => splitRowAtCursor(idx) },
                  "Split sentence"
                ),
                idx > 0 &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "btn-secondary",
                      onClick: () => runStructureOp({ type: "split", sentence_index: idx }),
                    },
                    "Split episode here"
                  )
              )
            ),
            h(
              "div",
              { className: "editor-controls" },
              h(
                "select",
                {
                  value: e.conversation_role,
                  onChange: (ev) => updateConversationRole(idx, ev.target.value),
                },
                CONVERSATION_ROLE_OPTIONS.map((value) => h("option", { key: value, value }, value))
              ),
              h(
                "select",
                {
                  value: e.communication_function,
                  onChange: (ev) => updateCommunicationFunction(idx, ev.target.value),
                },
                COMMUNICATION_FUNCTION_OPTIONS.map((value) => h("option", { key: value, value }, value))
              )
            )
          )
        )
      ),
      h(
        "div",
        { className: "editor-actions" },
        editorError && h("div", { className: "status-error" }, editorError),
        h(
          "button",
          {
            type: "button",
            className: "btn-secondary",
            onClick: () => {
              setMergeMode((m) => !m);
              setMergeSelection([]);
              setEditorError("");
            },
          },
          mergeMode ? "Cancel sentence merge" : "Merge sentences"
        ),
        mergeMode &&
          h(
            "button",
            {
              type: "button",
              className: "btn-primary",
              onClick: mergeSelected,
              disabled: mergeSelection.length !== 2,
            },
            "Merge selected"
          ),
        h("button", { type: "button", onClick: save }, "Save changes"),
        h("button", { type: "button", onClick: onClose }, "Cancel")
      )
    )
  );
}

function App() {
  const [status, setStatus] = useState("");
  const [pipelineStep, setPipelineStep] = useState("");
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [allItems, setAllItems] = useState([]);
  const [manifestPath, setManifestPath] = useState(null);
  const [speakers, setSpeakers] = useState({});
  const [speakerFallbackLabels, setSpeakerFallbackLabels] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [metricsReport, setMetricsReport] = useState(null);
  const [metricsComputing, setMetricsComputing] = useState(false);
  const [staticSessions, setStaticSessions] = useState([]);
  const [staticIndexBaseUrl, setStaticIndexBaseUrl] = useState(null);
  const [selectedStaticSessionId, setSelectedStaticSessionId] = useState("");
  const selectedStaticSession = useMemo(
    () => staticSessions.find((session) => session.id === selectedStaticSessionId) || null,
    [selectedStaticSessionId, staticSessions]
  );
  const collapsedCount = useMemo(
    () => allItems.filter((u) => u.collapsed).length,
    [allItems]
  );

  const submitFiles = useCallback(async (sessionFiles, speechFile = null) => {
    setError("");
    setPipelineStep("");
    const files = Array.from(sessionFiles || []);
    if (!files.length) {
      setError("Provide a map_timestamp folder.");
      return;
    }
    const stem = detectSessionStem(files);
    if (!stem) {
      setError("Folder must contain exactly one <map>_<timestamp>.json trajectory file.");
      return;
    }
    const audioFile = files.find((f) => f.name === `${stem}.wav`);
    if (!audioFile) {
      setError(`Folder must contain ${stem}.wav.`);
      return;
    }
    if (speechFile) {
      const speechStem = canonicalSessionStem(speechFile.name);
      if (speechStem !== stem) {
        setError(`speech_path basename (${speechStem}) must match ${stem}.`);
        return;
      }
    }
    try {
      const fd = new FormData();
      files.forEach((file, idx) => {
        fd.append(`session_file_${idx}`, file, file.webkitRelativePath || file.name);
      });
      if (speechFile) {
        fd.append("speech", speechFile);
      }
      const resp = await fetch("/api/pipeline/run", { method: "POST", body: fd });
      const data = await readResponseJson(resp, "/api/pipeline/run");
      if (!resp.ok) {
        setError((data && data.error) || `Pipeline request failed (${resp.status}).`);
        return;
      }
      setJobId(data.job_id);
      setStatus("queued");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const applyManifest = useCallback((manifest, nextManifestPath = null) => {
    const flat = flattenUtterances(manifest);
    setManifest(manifest);
    setAllItems(flat);
    const fallbackLabels = collectUniqueSpeakerLabels(manifest);
    setSpeakerFallbackLabels(fallbackLabels);
    setSpeakers(normalizeSpeakerMapping(manifest?.metadata?.speakers || {}, fallbackLabels));
    if (nextManifestPath) {
      setManifestPath(nextManifestPath);
    }
  }, []);

  const loadStaticSession = useCallback(
    async (session, indexBaseUrl = staticIndexBaseUrl) => {
      if (!session || !indexBaseUrl) return false;
      setError("");
      setPipelineStep("");
      setMetricsReport(null);
      const manifestUrl = staticAssetUrl(session.manifest, indexBaseUrl, Date.now());
      const mresp = await fetch(manifestUrl, { cache: "no-store" });
      if (!mresp.ok) {
        setError(`Could not load sample manifest: ${session.id}`);
        return false;
      }
      const rawManifest = await mresp.json();
      const nextManifest = readManifestObject(rawManifest);
      if (!nextManifest) {
        setError(`Invalid sample manifest: ${session.id}`);
        return false;
      }
      applyManifest(nextManifest, session.manifest || `${session.id}_labeled.json`);
      setVideoUrl(staticAssetUrl(session.video, indexBaseUrl, Date.now()));
      setStatus(`sample: ${session.label || session.id}`);
      setSelectedItem(null);
      const url = new URL(window.location.href);
      url.searchParams.set("session", session.id);
      window.history.replaceState({}, "", url);
      return true;
    },
    [applyManifest, staticIndexBaseUrl]
  );

  useEffect(() => {
    if (!IS_STATIC_MODE) return undefined;
    let cancelled = false;
    const run = async () => {
      try {
        const indexUrl = staticDataIndexUrl(Date.now());
        const resp = await fetch(indexUrl, { cache: "no-store" });
        if (!resp.ok) {
          setError("Could not load sample_data/index.json.");
          return;
        }
        const data = await resp.json();
        const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
        if (cancelled) return;
        const baseUrl = new URL(STATIC_CONFIG.dataIndexUrl || "../sample_data/index.json", window.location.href).toString();
        setStaticIndexBaseUrl(baseUrl);
        setStaticSessions(sessions);
        const requestedId = new URLSearchParams(window.location.search).get("session") || STATIC_CONFIG.defaultSessionId || sessions[0]?.id || "";
        setSelectedStaticSessionId(requestedId);
        const session = sessions.find((item) => item.id === requestedId) || sessions[0];
        if (session) {
          await loadStaticSession(session, baseUrl);
        } else {
          setStatus("static mode");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [loadStaticSession]);

  const loadManifestFromPath = useCallback(
    async (nextManifestPath) => {
      const url = repoAssetUrl(nextManifestPath, Date.now());
      const mresp = await fetch(url, { cache: "no-store" });
      if (!mresp.ok) {
        setError("Could not load generated speech manifest.");
        return false;
      }
      const rawManifest = await mresp.json();
      const manifest = readManifestObject(rawManifest);
      if (!manifest) {
        setError("Invalid speech manifest format.");
        return false;
      }
      applyManifest(manifest, nextManifestPath);
      return true;
    },
    [applyManifest]
  );

  useEffect(() => {
    if (!jobId) return undefined;
    const tick = async () => {
      try {
        const resp = await fetch(`/api/pipeline/status?job_id=${encodeURIComponent(jobId)}`);
        const data = await readResponseJson(resp, "/api/pipeline/status");
        if (!resp.ok) {
          setError((data && data.error) || "Status request failed.");
          setJobId(null);
          setPipelineStep("");
          return;
        }
        setStatus(String(data.status || ""));
        setPipelineStep(data.step != null && data.step !== "" ? String(data.step) : "");
        if (data.status === "error") {
          setError(String(data.error || "Pipeline failed."));
          setJobId(null);
          setPipelineStep("");
          return;
        }
        // Server clears `error` while the job runs; mirror that so stale UI errors
        // (metrics, video, earlier runs) do not stay visible during alignment/replay.
        if (!data.error) {
          setError("");
        }
        if (data.status === "done" && data.manifest_path && data.video_path) {
          setJobId(null);
          setPipelineStep("");
          setVideoUrl(repoAssetUrl(data.video_path, Date.now()));
          await loadManifestFromPath(data.manifest_path);
        } else if (data.status === "done") {
          setError("Pipeline finished but manifest or video path is missing.");
          setJobId(null);
          setPipelineStep("");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setJobId(null);
        setPipelineStep("");
      }
    };
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [jobId, loadManifestFromPath]);

  const computeLabeledVsSpeechMetrics = useCallback(async () => {
    if (IS_STATIC_MODE) {
      setError("Metrics are unavailable in GitHub Pages static mode.");
      return;
    }
    setMetricsComputing(true);
    setError("");
    setMetricsReport(null);
    try {
      const resp = await fetch("/api/metrics/compute-from-labeled");
      const data = await readResponseJson(resp, "/api/metrics/compute-from-labeled");
      if (!resp.ok) {
        setError((data && data.error) || "Metrics request failed.");
        return;
      }
      setMetricsReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMetricsComputing(false);
    }
  }, []);

  const openEditor = useCallback((item) => {
    setSelectedItem(item);
    const url = new URL(window.location.href);
    url.searchParams.set("edit", `${item.time_range[0]}-${item.time_range[1]}`);
    window.history.pushState({ edit: true }, "", url);
  }, []);

  const closeEditor = useCallback(() => {
    setSelectedItem(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    window.history.pushState({}, "", url);
  }, []);

  const refineSentenceTiming = useCallback(
    async (payload) => {
      if (IS_STATIC_MODE) {
        return payload?.edited_sentences || null;
      }
      if (!manifestPath) return null;
      const resp = await fetch("/api/labels/refine-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest_path: manifestPath, ...payload }),
      });
      const data = await readResponseJson(resp, "/api/labels/refine-timing");
      if (!resp.ok) {
        setError((data && data.error) || "Whisper refine failed.");
        return null;
      }
      return data.edited_sentences || null;
    },
    [manifestPath]
  );

  const saveEdits = useCallback(
    async (editPayload) => {
      const changedEdits = Array.isArray(editPayload?.edits) ? editPayload.edits : [];
      const sentenceEdits = Array.isArray(editPayload?.sentence_edits) ? editPayload.sentence_edits : [];
      const conversationEdits = Array.isArray(editPayload?.conversation_edits) ? editPayload.conversation_edits : [];
      const conversationOps = Array.isArray(editPayload?.conversation_ops) ? editPayload.conversation_ops : [];
      if (IS_STATIC_MODE) {
        if (manifest) {
          applyManifest(applyStaticConversationPayload(manifest, editPayload), manifestPath);
        }
        closeEditor();
        return;
      }
      if (
        !manifestPath ||
        (
          changedEdits.length === 0 &&
          sentenceEdits.length === 0 &&
          conversationEdits.length === 0 &&
          conversationOps.length === 0
        )
      ) {
        closeEditor();
        return;
      }
      try {
        const resp = await fetch("/api/labels/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest_path: manifestPath,
            edits: changedEdits,
            sentence_edits: sentenceEdits,
            conversation_edits: conversationEdits,
            conversation_ops: conversationOps,
          }),
        });
        const data = await readResponseJson(resp, "/api/labels/update");
        if (!resp.ok) {
          setError((data && data.error) || "Update failed.");
          return;
        }
        // Update local items from the updated manifest
        if (data.manifest_path) {
          await loadManifestFromPath(data.manifest_path);
        }
        closeEditor();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [manifest, manifestPath, closeEditor, loadManifestFromPath, applyManifest]
  );

  const saveSpeakers = useCallback(
    async (nextSpeakers) => {
      if (IS_STATIC_MODE) {
        if (manifest) {
          applyManifest({
            ...manifest,
            metadata: {
              ...(manifest.metadata || {}),
              speakers: nextSpeakers,
            },
          }, manifestPath);
        }
        return true;
      }
      if (!manifestPath) {
        setError("Run pipeline first so there is a manifest to update.");
        return false;
      }
      try {
        const resp = await fetch("/api/speakers/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest_path: manifestPath, speakers: nextSpeakers }),
        });
        const data = await readResponseJson(resp, "/api/speakers/update");
        if (!resp.ok) {
          setError((data && data.error) || "Speaker update failed.");
          return false;
        }
        if (data.manifest_path) {
          await loadManifestFromPath(data.manifest_path);
        } else {
          setSpeakers(nextSpeakers);
        }
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [manifest, manifestPath, loadManifestFromPath, applyManifest]
  );

  const selectStaticSession = useCallback(
    (sessionId) => {
      setSelectedStaticSessionId(sessionId);
      const session = staticSessions.find((item) => item.id === sessionId);
      if (session) void loadStaticSession(session, staticIndexBaseUrl);
    },
    [loadStaticSession, staticIndexBaseUrl, staticSessions]
  );

  const downloadCurrentManifest = useCallback(() => {
    if (!manifest || !selectedStaticSession) return;
    downloadJson(`${selectedStaticSession.id}_labeled.json`, manifest);
  }, [manifest, selectedStaticSession]);

  // Handle browser back/forward for edit view
  useEffect(() => {
    const onPop = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("edit")) {
        setSelectedItem(null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return h(
    "main",
    { className: "app" },
    h("header", { className: "toolbar" }, h("h1", null, "Moving Out conversation annotation")),
    IS_STATIC_MODE
      ? h(StaticSessionPicker, {
          sessions: staticSessions,
          selectedId: selectedStaticSessionId,
          onSelect: selectStaticSession,
        })
      : h(SessionUpload, {
          onSubmit: submitFiles,
          onError: (msg) => setError(msg),
          disabled: Boolean(jobId),
        }),
    h(
      "section",
      { className: "status" },
      status &&
        h(
          "div",
          null,
          pipelineStep ? `status: ${status} | step: ${pipelineStep}` : `status: ${status}`
        ),
      error && h("div", { className: "status-error" }, error),
      IS_STATIC_MODE &&
        h(
          "button",
          {
            type: "button",
            className: "btn-primary",
            disabled: !manifest || !selectedStaticSession,
            onClick: downloadCurrentManifest,
          },
          "Download JSON"
        ),
      !IS_STATIC_MODE && h(
        "div",
        { className: "metrics-panel" },
        h(
          "button",
          {
            type: "button",
            className: "btn-primary",
            disabled: metricsComputing,
            onClick: () => computeLabeledVsSpeechMetrics(),
          },
          metricsComputing ? "Computing..." : "Compute conversation metrics"
        ),
        metricsReport &&
          h(
            "div",
            { className: "metrics-report" },
            h(
              "p",
              { className: "metrics-summary-line" },
              `Labeled files: ${metricsReport.labeled_files_found ?? "-"} | Compared: ${metricsReport.files_compared ?? "-"} | Skipped: ${metricsReport.files_skipped ?? "-"}`
            ),
            (() => {
              const a = metricsReport.aggregate || {};
              return h(
                "div",
                { className: "metrics" },
                h("div", null, `Accuracy: ${a.accuracy != null ? Number(a.accuracy).toFixed(3) : "-"}`),
                h("div", null, `Macro F1: ${a.macro_f1 != null ? Number(a.macro_f1).toFixed(3) : "-"}`),
                h("div", null, `Weighted F1: ${a.weighted_f1 != null ? Number(a.weighted_f1).toFixed(3) : "-"}`),
                h(
                  "div",
                  { className: "metrics-total" },
                  `Label pairs: ${a.total_sentences != null ? a.total_sentences : "-"}`
                )
              );
            })(),
            Array.isArray(metricsReport.files) &&
              metricsReport.files.length > 0 &&
              h(
                "details",
                { className: "metrics-per-file" },
                h("summary", null, "Per file"),
                h(
                  "ul",
                  { className: "metrics-file-list" },
                  metricsReport.files.map((f) =>
                    h(
                      "li",
                      { key: f.stem + (f.labeled_file || "") },
                      f.error
                        ? `${f.stem}: skipped - ${f.error}`
                        : `${f.stem}: acc ${f.accuracy != null ? Number(f.accuracy).toFixed(3) : "-"}, ` +
                            `pairs ${f.pairs ?? 0}`
                    )
                  )
                )
              )
          )
      )
    ),
    h(
      "div",
      { className: "top-panels" },
      h(SessionVideo, { src: videoUrl, onMediaError: (msg) => setError(msg) }),
      h(SpeakerIdentification, {
        speakers,
        fallbackLabels: speakerFallbackLabels,
        onSave: saveSpeakers,
        disabled: !manifestPath,
      })
    ),
    h(
      "section",
      { className: "segment-panel" },
      !selectedItem &&
        h(
          Fragment,
          null,
          h("h2", null, "Conversation episodes"),
          h(SegmentList, {
            videoSrc: videoUrl,
            items: allItems,
            collapsedCount,
            totalCount: allItems.length,
            onSelect: openEditor,
          })
        ),
      selectedItem &&
        h(ParagraphEditor, {
          item: selectedItem,
          onClose: closeEditor,
          onSave: saveEdits,
          onRefine: refineSentenceTiming,
          videoSrc: videoUrl,
        })
    )
  );
}

createRoot(document.getElementById("root")).render(h(App, null));
