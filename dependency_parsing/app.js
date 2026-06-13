import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from "react";
import { createRoot } from "react-dom/client";

const PX_PER_SECOND = 152 * (2 / 3);
const LABEL_W = 136;
const GRAPH_PAD = 24;
const MIN_NODE_W = 132;
const FRAME_STEP_S = 1;
const THUMB_W = 152;
const THUMB_H = 88;
const SPEECH_MIN_W = 110;
const ACTION_NODE_H = 70;
const SPEECH_NODE_H = 62;
const ACTION_ROW_H = 82;
const SPEECH_ROW_H = 120;
const ROWS = {
  timeline: { top: 0, height: 120, label: "Timeline" },
  redAction: { top: 70, height: ACTION_ROW_H, label: "Red Agent Action" },
  redSpeech: { top: 325, height: SPEECH_ROW_H, label: "Red Agent Speech" },
  blueSpeech: { top: 530, height: SPEECH_ROW_H, label: "Blue Agent Speech" },
  blueAction: { top: 710, height: ACTION_ROW_H, label: "Blue Agent Action" },
};
const CANVAS_H = 900;
const RELATION_STROKE_W = 5;
const RELATION_LANE_SPACING = 25;
const RELATION_HORIZONTAL_GAP = 25;
const RELATION_STEM_SPACING = 26;
const RELATION_ANCHOR_SPREAD = 0.16;
const RELATION_LABEL_MAX_DISTANCE = 30;
const RELATION_ENDPOINT_STACK_GAP = 15;
const RELATION_ENDPOINT_EDGE_INSET = 6;
const RELATION_LANE_EDGE_PAD = 6;
const MIN_LANE_GAPS = {
  redActionAbove: 70,
  redActionGap: 70,
  speechGap: 70,
  blueActionGap: 70,
  blueActionBelow: 70,
};
const EMPTY_LANE_NEEDS = Object.freeze({
  redActionAbove: 0,
  redActionGap: 0,
  speechGap: 0,
  blueActionGap: 0,
  blueActionBelow: 0,
});
const DEFAULT_RELATION_LABEL_SETS = {
  action_action: ["trigger", "follow", "others"],
  action_conversation: ["trigger", "follow", "others"],
  action_speech: ["trigger", "follow", "others"],
  speech_speech: ["revise_plan", "confirm", "refuse", "others"],
  conversation_conversation: ["response", "confirm", "answer", "clarify", "revise_plan", "unclear"],
};
const CONVERSATION_ROLE_OPTIONS = ["initiating_conversation", "response"];

function repoAssetUrl(relPath, cacheBust) {
  if (!relPath) return null;
  const norm = String(relPath).trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return null;
  return `/${norm}${cacheBust != null ? `?t=${cacheBust}` : ""}`;
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

async function readResponseJson(resp, urlLabel) {
  const text = await resp.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype")) {
    throw new Error(`Server returned HTML instead of JSON for ${urlLabel}. Restart scripts/web_visualization_server.py from the repo root.`);
  }
  if (!trimmed) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON from ${urlLabel}: ${msg}`);
  }
}

function canonicalSessionStem(name) {
  let stem = String(name || "").replace(/\.[^.]+$/, "");
  while (stem.endsWith("_labeled")) stem = stem.slice(0, -"_labeled".length);
  if (stem.endsWith("_speech")) stem = stem.slice(0, -"_speech".length);
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

function readManifestObject(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.conversations) || Array.isArray(raw.paragraphs) || Array.isArray(raw.segments)) return raw;
  return null;
}

function fmtTime(value) {
  const n = Number(value || 0);
  return `${n.toFixed(2)}s`;
}

function rangeStart(range) {
  return Number(range?.[0] || 0);
}

function rangeEnd(range) {
  return Number(range?.[1] ?? rangeStart(range));
}

function rangeText(range) {
  return `${fmtTime(rangeStart(range))} - ${fmtTime(rangeEnd(range))}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function speechId(convId, sent, idx) {
  return String(
    sent?.speech_id ||
      sent?.sentence_key ||
      `${convId}_speech_${String(idx).padStart(3, "0")}`
  );
}

function normalizeSpeaker(speaker) {
  const text = String(speaker || "").toLowerCase().replace(/\s+/g, "_");
  if (text.includes("red") || text === "robot_2" || text === "speaker_2") return "red_agent";
  return "blue_agent";
}

function conversationsFromManifest(manifest) {
  if (Array.isArray(manifest?.conversations)) {
    return manifest.conversations.map((conv, idx) => {
      const sentences = Array.isArray(conv.sentences) ? conv.sentences : [];
      const start = rangeStart(conv.time_range || sentences[0]?.time_range || [0, 0]);
      const end = rangeEnd(conv.time_range || sentences[sentences.length - 1]?.time_range || [start, start]);
      const convId = conv.conversation_id || `conv_${String(idx).padStart(3, "0")}`;
      return {
        ...conv,
        conversation_id: convId,
        time_range: [start, end],
        sentences: sentences.map((sent, sentIdx) => ({
          ...sent,
          speech_id: speechId(convId, sent, sentIdx),
          conversation_id: convId,
        })),
      };
    });
  }
  const out = [];
  for (const par of manifest?.paragraphs || []) {
    const sentences = Array.isArray(par.sentences) ? par.sentences : [];
    if (!sentences.length) continue;
    const convId = `conv_${String(out.length).padStart(3, "0")}`;
    out.push({
      conversation_id: convId,
      time_range: par.time_range || [rangeStart(sentences[0].time_range), rangeEnd(sentences[sentences.length - 1].time_range)],
      action_window: par.action_window,
      follow_label: par.follow_label || "unclear",
      sentences: sentences.map((sent, sentIdx) => ({
        ...sent,
        speech_id: speechId(convId, sent, sentIdx),
        conversation_id: convId,
      })),
    });
  }
  return out;
}

function manifestDuration(manifest, conversations, actionEpisodes) {
  const metadataDuration = Number(manifest?.metadata?.duration_s || 0);
  const convMax = Math.max(0, ...conversations.map((c) => rangeEnd(c.time_range || [])));
  const actionMax = Math.max(0, ...actionEpisodes.map((a) => rangeEnd(a.time_range || [])));
  return Math.max(metadataDuration, convMax, actionMax, 1);
}

function relationType(sourceType, targetType) {
  if (sourceType === "action" && targetType === "action") return "action_action";
  if (sourceType === "speech" && targetType === "speech") return "speech_speech";
  if ([sourceType, targetType].includes("action") && [sourceType, targetType].includes("speech")) return "action_speech";
  if (sourceType === "conversation" && targetType === "conversation") return "conversation_conversation";
  return "action_conversation";
}

function sortActionEpisodes(episodes) {
  return [...(episodes || [])].sort((a, b) => {
    const agentCmp = normalizeSpeaker(a.agent).localeCompare(normalizeSpeaker(b.agent));
    if (agentCmp !== 0) return agentCmp;
    return rangeStart(a.time_range) - rangeStart(b.time_range) || rangeEnd(a.time_range) - rangeEnd(b.time_range);
  });
}

function mergedActionTitle(a, b) {
  const first = String(a?.title || "").trim();
  const second = String(b?.title || "").trim();
  if (!first) return second;
  if (!second || first === second) return first;
  return `${first} / ${second}`;
}

function remapRelations(relations, remapsByType) {
  const seen = new Set();
  const out = [];
  for (const rel of relations || []) {
    const sourceMap = remapsByType[rel.source_type];
    const targetMap = remapsByType[rel.target_type];
    const next = {
      ...rel,
      source_id: sourceMap?.get(rel.source_id) || rel.source_id,
      target_id: targetMap?.get(rel.target_id) || rel.target_id,
    };
    if (next.source_type === next.target_type && next.source_id === next.target_id) {
      continue;
    }
    const key = `${next.source_type}:${next.source_id}->${next.target_type}:${next.target_id}:${next.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

function removeRelationsForNode(relations, type, id) {
  return (relations || []).filter(
    (rel) =>
      !(rel.source_type === type && rel.source_id === id) &&
      !(rel.target_type === type && rel.target_id === id)
  );
}

function safeTagName(target) {
  return String(target?.tagName || "").toUpperCase();
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`video ${eventName} failed`));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function useVideoFrames(videoSrc, duration, frameStep = FRAME_STEP_S) {
  const [state, setState] = useState({ frames: [], loading: false, error: "" });

  useEffect(() => {
    if (!videoSrc || !duration) {
      setState({ frames: [], loading: false, error: "" });
      return undefined;
    }
    let cancelled = false;
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = videoSrc;

    async function capture() {
      setState({ frames: [], loading: true, error: "" });
      try {
        await waitForEvent(video, "loadedmetadata");
        const maxT = Math.max(0, Math.min(duration, Number(video.duration || duration)));
        const nextFrames = [];
        for (let t = 0; t <= maxT + 0.001; t += frameStep) {
          if (cancelled) return;
          const targetTime = Math.min(t, Math.max(0, maxT - 0.02));
          if (Math.abs(video.currentTime - targetTime) > 0.02) {
            video.currentTime = targetTime;
            await waitForEvent(video, "seeked");
          } else {
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          if (cancelled) return;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const vw = video.videoWidth || canvas.width;
          const vh = video.videoHeight || canvas.height;
          const scale = Math.min(canvas.width / vw, canvas.height / vh);
          const dw = Math.max(1, vw * scale);
          const dh = Math.max(1, vh * scale);
          const dx = (canvas.width - dw) / 2;
          const dy = (canvas.height - dh) / 2;
          ctx.drawImage(video, dx, dy, dw, dh);
          nextFrames.push({
            time: Number(t.toFixed(2)),
            dataUrl: canvas.toDataURL("image/jpeg", 0.72),
          });
        }
        if (!cancelled) {
          setState({ frames: nextFrames, loading: false, error: "" });
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            frames: [],
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    capture();
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [duration, frameStep, videoSrc]);

  return state;
}

function framesForRange(frames, range, frameStep = FRAME_STEP_S) {
  const start = rangeStart(range);
  const end = rangeEnd(range);
  return (frames || []).filter((frame) => frame.time < end && frame.time + frameStep > start);
}

function timeWidth(range) {
  return Math.max(2, (rangeEnd(range) - rangeStart(range)) * PX_PER_SECOND);
}

function expandSpeechRects(conversations, baseSentenceRect, timeToX, graphWidth) {
  const expanded = new Map();
  const minGraphX = LABEL_W + GRAPH_PAD;
  const maxGraphX = Math.max(minGraphX, graphWidth - GRAPH_PAD);
  const convItems = (conversations || [])
    .map((conv) => {
      const range = conversationBounds(conv);
      const left = timeToX(rangeStart(range));
      const right = left + timeWidth(range);
      return { conv, left, right, start: rangeStart(range), end: rangeEnd(range) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const limitsById = new Map();
  convItems.forEach((item, idx) => {
    const prev = convItems[idx - 1];
    const next = convItems[idx + 1];
    limitsById.set(item.conv.conversation_id, {
      left: Math.max(minGraphX, prev ? prev.right + 8 : minGraphX),
      right: Math.min(maxGraphX, next ? next.left - 8 : maxGraphX),
    });
  });

  for (const conv of conversations || []) {
    const limits = limitsById.get(conv.conversation_id);
    if (!limits || limits.right <= limits.left) continue;
    const byRow = new Map();
    for (const sent of conv.sentences || []) {
      const rect = baseSentenceRect(sent, conv.time_range);
      const rowKey = normalizeSpeaker(sent.speaker) === "red_agent" ? "redSpeech" : "blueSpeech";
      if (!byRow.has(rowKey)) byRow.set(rowKey, []);
      byRow.get(rowKey).push({ sent, rect, center: rectCenter(rect).x });
    }

    byRow.forEach((items) => {
      const sorted = [...items].sort((a, b) => a.rect.left - b.rect.left);
      sorted.forEach((item, idx) => {
        let leftLimit = limits.left + 8;
        let rightLimit = limits.right - 8;
        const prev = sorted[idx - 1];
        const next = sorted[idx + 1];
        if (prev) {
          leftLimit = Math.max(leftLimit, (prev.center + item.center) / 2 + 3);
        }
        if (next) {
          rightLimit = Math.min(rightLimit, (item.center + next.center) / 2 - 3);
        }
        const available = rightLimit - leftLimit;
        if (available <= item.rect.width) {
          expanded.set(item.sent.speech_id, item.rect);
          return;
        }
        const targetWidth = Math.min(Math.max(item.rect.width, SPEECH_MIN_W), available);
        const left = clamp(item.center - targetWidth / 2, leftLimit, rightLimit - targetWidth);
        expanded.set(item.sent.speech_id, {
          ...item.rect,
          left,
          right: left + targetWidth,
          width: targetWidth,
        });
      });
    });
  }

  return expanded;
}

function sentenceBounds(sentences, fallbackRange = [0, 0]) {
  const ranges = (sentences || []).map((sent) => sent.time_range).filter(Array.isArray);
  if (!ranges.length) return fallbackRange;
  return [
    Math.min(...ranges.map(rangeStart)),
    Math.max(...ranges.map(rangeEnd)),
  ];
}

function conversationBounds(conv, includeExistingRange = true) {
  const sentenceRanges = (conv.sentences || []).map((sent) => sent.time_range || [0, 0]);
  const sentenceRange = sentenceBounds(conv.sentences || [], conv.time_range || [0, 0]);
  const start = includeExistingRange
    ? Math.min(rangeStart(conv.time_range || sentenceRange), ...sentenceRanges.map(rangeStart))
    : rangeStart(sentenceRange);
  const end = includeExistingRange
    ? Math.max(rangeEnd(conv.time_range || [start, start]), ...sentenceRanges.map(rangeEnd))
    : rangeEnd(sentenceRange);
  return [Number.isFinite(start) ? start : 0, Number.isFinite(end) ? end : 0];
}

function renumberConversations(conversations) {
  return (conversations || []).map((conv, idx) => {
    const convId = `conv_${String(idx).padStart(3, "0")}`;
    const sentences = (conv.sentences || []).map((sent, sentIdx) => ({
      ...sent,
      conversation_id: convId,
      sentence_index: sentIdx,
      speech_id: speechId(convId, sent, sentIdx),
    }));
    const range = sentenceBounds(sentences, conv.time_range || [0, 0]);
    return {
      ...conv,
      conversation_id: convId,
      time_range: conv.time_range || range,
      sentences,
    };
  });
}

function rectCenter(rect) {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  };
}

function edgePoint(fromRect, toPoint) {
  const center = rectCenter(fromRect);
  const dx = toPoint.x - center.x;
  const dy = toPoint.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const halfW = Math.max(1, (fromRect.right - fromRect.left) / 2);
  const halfH = Math.max(1, (fromRect.bottom - fromRect.top) / 2);
  const scale = Math.min(
    Math.abs(dx) > 0 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY,
    Math.abs(dy) > 0 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY
  );
  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  };
}

function anchorInset(size) {
  if (size <= 2) return 0;
  return Math.min(size / 2, clamp(size * 0.24, 12, 44));
}

function verticalAnchorInset(size) {
  if (size <= 2) return 0;
  return Math.min(size / 2, RELATION_ENDPOINT_EDGE_INSET);
}

function anchorX(rect, x) {
  const width = rect.right - rect.left;
  const inset = anchorInset(width);
  if (width <= inset * 2) return (rect.left + rect.right) / 2;
  return clamp(x, rect.left + inset, rect.right - inset);
}

function anchorY(rect, y) {
  const height = rect.bottom - rect.top;
  const inset = verticalAnchorInset(height);
  if (height <= inset * 2) return (rect.top + rect.bottom) / 2;
  return clamp(y, rect.top + inset, rect.bottom - inset);
}

function relationAnchorOffset(routeIndex, laneIndex = 0, mirror = false) {
  const offsets = [-0.04, 0.04, -0.018, 0.018, -0.07, 0.07, 0];
  const idx = Math.abs(routeIndex + laneIndex * 2) % offsets.length;
  return mirror ? -offsets[idx] : offsets[idx];
}

function horizontalAnchor(rect, otherRect, offset = 0) {
  const center = rectCenter(rect);
  const other = rectCenter(otherRect);
  const toRight = other.x >= center.x;
  const height = rect.bottom - rect.top;
  return {
    x: toRight ? rect.right : rect.left,
    y: anchorY(rect, center.y + height * offset),
    side: toRight ? "right" : "left",
  };
}

function verticalAnchor(rect, otherRect, offset = 0) {
  const center = rectCenter(rect);
  const other = rectCenter(otherRect);
  const toBottom = other.y >= center.y;
  const width = rect.right - rect.left;
  const sideBias = other.x > center.x ? 0.05 : other.x < center.x ? -0.05 : 0;
  const xOffset = clamp(sideBias + offset * 0.45, -0.16, 0.16);
  return {
    x: anchorX(rect, center.x + width * xOffset),
    y: toBottom ? rect.bottom : rect.top,
    side: toBottom ? "bottom" : "top",
  };
}

function preferredAnchor(rect, otherRect, offset = 0) {
  const center = rectCenter(rect);
  const other = rectCenter(otherRect);
  const dx = other.x - center.x;
  const dy = other.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy) * 0.45) {
    return horizontalAnchor(rect, otherRect, offset);
  }
  return verticalAnchor(rect, otherRect, offset);
}

function sameRowStraightPoints(src, dst, routeIndex, laneIndex, laneCount = 1, anchorOffsets = {}) {
  if (src.rowKey !== dst.rowKey) return null;
  const srcCenter = rectCenter(src);
  const dstCenter = rectCenter(dst);
  const srcBeforeDst = srcCenter.x <= dstCenter.x;
  const minY = Math.max(src.top + verticalAnchorInset(src.bottom - src.top), dst.top + verticalAnchorInset(dst.bottom - dst.top));
  const maxY = Math.min(src.bottom - verticalAnchorInset(src.bottom - src.top), dst.bottom - verticalAnchorInset(dst.bottom - dst.top));
  if (maxY < minY) return null;
  const offset =
    ((Number(anchorOffsets.sourceOffset ?? relationAnchorOffset(routeIndex, laneIndex)) +
      Number(anchorOffsets.targetOffset ?? relationAnchorOffset(routeIndex, laneIndex))) /
      2);
  const y =
    laneCount > 1
      ? minY + ((laneIndex + 1) / (laneCount + 1)) * (maxY - minY)
      : clamp((srcCenter.y + dstCenter.y) / 2 + Math.min(src.bottom - src.top, dst.bottom - dst.top) * offset, minY, maxY);
  return [
    { x: srcBeforeDst ? src.right : src.left, y },
    { x: srcBeforeDst ? dst.left : dst.right, y },
  ];
}

function crossRowVerticalPoints(src, dst, routeIndex, laneIndex, laneCount = 1, anchorOffsets = {}) {
  if (src.rowKey === dst.rowKey) return null;
  const srcCenter = rectCenter(src);
  const dstCenter = rectCenter(dst);
  const srcInset = anchorInset(src.right - src.left);
  const dstInset = anchorInset(dst.right - dst.left);
  const overlapLeft = Math.max(src.left + srcInset, dst.left + dstInset);
  const overlapRight = Math.min(src.right - srcInset, dst.right - dstInset);
  if (overlapRight < overlapLeft) return null;
  const sourceOffset = Number(anchorOffsets.sourceOffset ?? relationAnchorOffset(routeIndex, laneIndex));
  const targetOffset = Number(anchorOffsets.targetOffset ?? -sourceOffset);
  const sourceDesiredX = anchorX(src, srcCenter.x + (src.right - src.left) * sourceOffset);
  const targetDesiredX = anchorX(dst, dstCenter.x + (dst.right - dst.left) * targetOffset);
  const x =
    laneCount > 1
      ? overlapLeft + ((laneIndex + 1) / (laneCount + 1)) * (overlapRight - overlapLeft)
      : clamp(
          (sourceDesiredX + targetDesiredX) / 2,
          overlapLeft,
          overlapRight
        );
  const dstBelow = dstCenter.y >= srcCenter.y;
  return [
    { x, y: dstBelow ? src.bottom : src.top },
    { x, y: dstBelow ? dst.top : dst.bottom },
  ];
}

function inflatedRect(rect, pad = 8) {
  return {
    left: rect.left - pad,
    right: rect.right + pad,
    top: rect.top - pad,
    bottom: rect.bottom + pad,
  };
}

function pointInRect(point, rect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function orientation(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 0.0001) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    b.x <= Math.max(a.x, c.x) + 0.0001 &&
    b.x + 0.0001 >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) + 0.0001 &&
    b.y + 0.0001 >= Math.min(a.y, c.y)
  );
}

function segmentsIntersect(p1, p2, q1, q2) {
  const o1 = orientation(p1, p2, q1);
  const o2 = orientation(p1, p2, q2);
  const o3 = orientation(q1, q2, p1);
  const o4 = orientation(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, q1, p2)) return true;
  if (o2 === 0 && onSegment(p1, q2, p2)) return true;
  if (o3 === 0 && onSegment(q1, p1, q2)) return true;
  if (o4 === 0 && onSegment(q1, p2, q2)) return true;
  return false;
}

function segmentIntersectsRect(a, b, rect) {
  if (Math.max(a.x, b.x) < rect.left || Math.min(a.x, b.x) > rect.right) return false;
  if (Math.max(a.y, b.y) < rect.top || Math.min(a.y, b.y) > rect.bottom) return false;
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const tl = { x: rect.left, y: rect.top };
  const tr = { x: rect.right, y: rect.top };
  const br = { x: rect.right, y: rect.bottom };
  const bl = { x: rect.left, y: rect.bottom };
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  );
}

function pathIsClear(points, obstacles, pad = 8) {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    for (const obstacle of obstacles) {
      if (segmentIntersectsRect(a, b, inflatedRect(obstacle, pad))) {
        return false;
      }
    }
  }
  return true;
}

function relationStraightPathIsClear(rel, points, obstacles) {
  void rel;
  return pathIsClear(points, obstacles);
}

function relationAllowsStraightPath(rel, src, dst) {
  if (rel.relation_type === "action_action" && src.rowKey === dst.rowKey) return false;
  return true;
}

function relationObstacles(layout, rel) {
  return Array.from(layout.entries())
    .filter(([id, rect]) => id !== rel.source_id && id !== rel.target_id && rect.type !== "conversation")
    .map(([, rect]) => rect);
}

function sortedAnchorOffsets(items) {
  if (!items.length) return;
  const denom = Math.max(1, items.length - 1);
  const anchorSpan = items.reduce(
    (minSpan, item) => Math.min(minSpan, Math.max(1, Number(item.anchorSpan) || 1)),
    Number.POSITIVE_INFINITY
  );
  const edgeInset = items.reduce(
    (maxInset, item) => Math.max(maxInset, Math.max(0, Number(item.edgeInset) || 0)),
    0
  );
  const minSpreadForEndpointGap = items.length > 1
    ? (RELATION_ENDPOINT_STACK_GAP * denom) / (2 * anchorSpan)
    : 0;
  const maxSpread = Math.max(0, 0.5 - edgeInset / anchorSpan);
  const spread = Math.min(Math.max(RELATION_ANCHOR_SPREAD, minSpreadForEndpointGap), maxSpread);
  items.forEach((item, idx) => {
    const offset =
      items.length === 1
        ? 0
        : ((idx / denom) - 0.5) * 2 * spread;
    item.setOffset(offset);
  });
}

function endpointAnchorUsesHorizontalEdge(rect, bounds) {
  const laneMidY = (bounds[0] + bounds[1]) / 2;
  return laneMidY < rect.top || laneMidY > rect.bottom;
}

function endpointAnchorSpan(rect, bounds) {
  return endpointAnchorUsesHorizontalEdge(rect, bounds)
    ? rect.right - rect.left
    : rect.bottom - rect.top;
}

function endpointAnchorEdgeInset(rect, bounds) {
  return endpointAnchorUsesHorizontalEdge(rect, bounds)
    ? anchorInset(rect.right - rect.left)
    : verticalAnchorInset(rect.bottom - rect.top);
}

function buildRelationAnchorOffsets(candidates) {
  const offsets = new Map();
  const ensure = (relationId) => {
    if (!offsets.has(relationId)) offsets.set(relationId, { sourceOffset: 0, targetOffset: 0 });
    return offsets.get(relationId);
  };
  const endpointsByNode = new Map();
  const addEndpoint = (nodeKey, endpoint) => {
    if (!endpointsByNode.has(nodeKey)) endpointsByNode.set(nodeKey, []);
    endpointsByNode.get(nodeKey).push(endpoint);
  };

  candidates.forEach((candidate) => {
    const sourceKey = candidate.rel.source_id;
    const targetKey = candidate.rel.target_id;
    const dstCenter = rectCenter(candidate.dst);
    const srcCenter = rectCenter(candidate.src);
    addEndpoint(sourceKey, {
      sortX: dstCenter.x,
      sortY: dstCenter.y,
      sortRole: 0,
      anchorSpan: endpointAnchorSpan(candidate.src, candidate.bounds),
      edgeInset: endpointAnchorEdgeInset(candidate.src, candidate.bounds),
      setOffset: (offset) => {
        ensure(candidate.rel.relation_id).sourceOffset = offset;
      },
    });
    addEndpoint(targetKey, {
      sortX: srcCenter.x,
      sortY: srcCenter.y,
      sortRole: 1,
      anchorSpan: endpointAnchorSpan(candidate.dst, candidate.bounds),
      edgeInset: endpointAnchorEdgeInset(candidate.dst, candidate.bounds),
      setOffset: (offset) => {
        ensure(candidate.rel.relation_id).targetOffset = offset;
      },
    });
  });

  const sortItems = (items) =>
    [...items].sort((a, b) => a.sortX - b.sortX || a.sortY - b.sortY || a.sortRole - b.sortRole);
  endpointsByNode.forEach((items) => sortedAnchorOffsets(sortItems(items)));
  return offsets;
}

function relationLaneCategory(rel, sourceRowKey, targetRowKey) {
  const rowKeys = [sourceRowKey, targetRowKey];

  if (rel.relation_type === "action_action") {
    if (sourceRowKey === "redAction" && targetRowKey === "redAction") return "redActionAbove";
    if (sourceRowKey === "blueAction" && targetRowKey === "blueAction") return "blueActionBelow";
    return "speechGap";
  }
  if (rel.relation_type === "speech_speech") return "speechGap";
  if (rel.relation_type === "conversation_conversation") return "speechGap";
  if (rowKeys.includes("redAction") && rowKeys.includes("redSpeech")) {
    return "redActionGap";
  }
  if (rowKeys.includes("blueAction") && rowKeys.includes("blueSpeech")) {
    return "blueActionGap";
  }
  if (rowKeys.includes("redAction")) return "redActionGap";
  if (rowKeys.includes("blueAction")) return "blueActionGap";
  return "speechGap";
}

function relationLaneBoundsY(rel, src, dst, rows = ROWS, canvasHeight = CANVAS_H) {
  const timelineBottom = rows.timeline.top + rows.timeline.height;
  const redActionBottom = rows.redAction.top + rows.redAction.height;
  const redSpeechBottom = rows.redSpeech.top + rows.redSpeech.height;
  const blueSpeechBottom = rows.blueSpeech.top + rows.blueSpeech.height;
  const blueActionBottom = rows.blueAction.top + rows.blueAction.height;
  const boundsByCategory = {
    redActionAbove: [timelineBottom + RELATION_LANE_EDGE_PAD, rows.redAction.top - RELATION_LANE_EDGE_PAD],
    redActionGap: [redActionBottom + RELATION_LANE_EDGE_PAD, rows.redSpeech.top - RELATION_LANE_EDGE_PAD],
    speechGap: [redSpeechBottom + RELATION_LANE_EDGE_PAD, rows.blueSpeech.top - RELATION_LANE_EDGE_PAD],
    blueActionGap: [blueSpeechBottom + RELATION_LANE_EDGE_PAD, rows.blueAction.top - RELATION_LANE_EDGE_PAD],
    blueActionBelow: [blueActionBottom + RELATION_LANE_EDGE_PAD, canvasHeight - RELATION_LANE_EDGE_PAD],
  };
  return boundsByCategory[relationLaneCategory(rel, src.rowKey, dst.rowKey)] || boundsByCategory.speechGap;
}

function relationLaneYFromBounds(bounds, laneIndex, laneCount = 1) {
  const [minY, maxY] = bounds;
  if (maxY <= minY) return (minY + maxY) / 2;
  if (laneCount <= 1) return (minY + maxY) / 2;
  return minY + ((laneIndex + 1) / (laneCount + 1)) * (maxY - minY);
}

function routeXOffset(routeIndex, laneIndex = 0) {
  const seed = routeIndex + laneIndex * 2;
  if (seed === 0) return 0;
  const magnitude = Math.ceil(seed / 2);
  return (seed % 2 === 1 ? 1 : -1) * magnitude * RELATION_STEM_SPACING;
}

function connectionPoint(rect, laneY, otherCenter, anchorOffset = 0) {
  const center = rectCenter(rect);
  const rectWidth = rect.right - rect.left;
  const directionalBias = otherCenter.x >= center.x ? 0.025 : -0.025;
  const edgeX = rectWidth > 24 ? anchorX(rect, center.x + rectWidth * (anchorOffset + directionalBias)) : center.x;
  if (laneY < rect.top) return { x: edgeX, y: rect.top, side: "top" };
  if (laneY > rect.bottom) return { x: edgeX, y: rect.bottom, side: "bottom" };
  return {
    x: otherCenter.x < center.x ? rect.left : rect.right,
    y: anchorY(rect, laneY),
    side: otherCenter.x < center.x ? "left" : "right",
  };
}

function stemPointForConnection(point, rect, xOffset, laneY) {
  if (point.side === "top" || point.side === "bottom") {
    return { x: rectCenter(rect).x + xOffset, y: point.y };
  }
  const outward = point.side === "left" ? -1 : 1;
  return { x: point.x + outward * Math.max(RELATION_STEM_SPACING, Math.abs(xOffset)), y: laneY };
}

function pathFromPoints(points) {
  return points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function closestPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0.0001) return { ...a, distance: Math.hypot(point.x - a.x, point.y - a.y) };
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { x, y, distance: Math.hypot(point.x - x, point.y - y) };
}

function closestPointOnPath(point, points) {
  let closest = null;
  for (let i = 1; i < points.length; i += 1) {
    const candidate = closestPointOnSegment(point, points[i - 1], points[i]);
    if (!closest || candidate.distance < closest.distance) closest = candidate;
  }
  return closest || { ...point, distance: 0 };
}

function constrainLabelPositionToRoute(position, route, maxDistance = RELATION_LABEL_MAX_DISTANCE) {
  const points = route?.points || [];
  if (!position || points.length < 2) return position || route?.labelPosition || { x: 0, y: 0 };
  const closest = closestPointOnPath(position, points);
  if (closest.distance <= maxDistance) return position;
  const dx = position.x - closest.x;
  const dy = position.y - closest.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.0001) return { x: closest.x, y: closest.y };
  return {
    x: closest.x + (dx / length) * maxDistance,
    y: closest.y + (dy / length) * maxDistance,
  };
}

function routeLabelPosition(points) {
  let best = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || length > best.length) {
      best = {
        length,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    }
  }
  return best ? { x: best.x, y: best.y } : points[0] || { x: 0, y: 0 };
}

function relationLaneGroupKey(category, bounds) {
  return `${category}:${Math.round(bounds[0])}:${Math.round(bounds[1])}`;
}

function maxOverlappingRelationLanes(group) {
  const laneEnds = [];
  const sorted = [...group].sort(
    (a, b) => a.spanStart - b.spanStart || a.spanEnd - b.spanEnd
  );
  sorted.forEach((candidate) => {
    let laneIndex = laneEnds.findIndex((end) => end <= candidate.spanStart);
    if (laneIndex < 0) laneIndex = laneEnds.length;
    laneEnds[laneIndex] = candidate.spanEnd;
  });
  return laneEnds.length;
}

function actualGapRouteSpan(candidate, anchorOffsets = {}) {
  const laneY = relationLaneYFromBounds(candidate.bounds, 0, 1);
  const start = connectionPoint(
    candidate.src,
    laneY,
    rectCenter(candidate.dst),
    anchorOffsets.sourceOffset || 0
  );
  const end = connectionPoint(
    candidate.dst,
    laneY,
    rectCenter(candidate.src),
    anchorOffsets.targetOffset || 0
  );
  return {
    spanStart: Math.min(start.x, end.x),
    spanEnd: Math.max(start.x, end.x),
  };
}

function relationCandidatesFromLayout(relations, layout, rows = ROWS, canvasHeight = CANVAS_H) {
  const candidates = [];
  relations.forEach((rel, index) => {
    const src = layout.get(rel.source_id);
    const dst = layout.get(rel.target_id);
    if (!src || !dst) return;
    const category = relationLaneCategory(rel, src.rowKey, dst.rowKey);
    const bounds = relationLaneBoundsY(rel, src, dst, rows, canvasHeight);
    candidates.push({
      rel,
      index,
      src,
      dst,
      category,
      bounds,
      groupKey: relationLaneGroupKey(category, bounds),
    });
  });
  return candidates;
}

function laneCandidatesWithActualSpans(candidates, layout, anchorOffsetsByRelation) {
  return candidates
    .filter((candidate) =>
      routeNeedsGapLane(
        candidate.rel,
        candidate.src,
        candidate.dst,
        candidate.index,
        relationObstacles(layout, candidate.rel),
        anchorOffsetsByRelation.get(candidate.rel.relation_id) || {}
      )
    )
    .map((candidate) => ({
      ...candidate,
      ...actualGapRouteSpan(
        candidate,
        anchorOffsetsByRelation.get(candidate.rel.relation_id) || {}
      ),
    }));
}

function estimateLaneNeedsFromLayout(relations, layout, rows = ROWS, canvasHeight = CANVAS_H) {
  const candidates = relationCandidatesFromLayout(relations, layout, rows, canvasHeight);
  const anchorOffsetsByRelation = buildRelationAnchorOffsets(candidates);
  const laneCandidates = laneCandidatesWithActualSpans(candidates, layout, anchorOffsetsByRelation);
  const groups = new Map();
  laneCandidates.forEach((candidate) => {
    if (!groups.has(candidate.groupKey)) groups.set(candidate.groupKey, []);
    groups.get(candidate.groupKey).push(candidate);
  });
  const needs = { ...EMPTY_LANE_NEEDS };
  groups.forEach((group) => {
    const category = group[0]?.category;
    if (!category) return;
    needs[category] = Math.max(needs[category] || 0, maxOverlappingRelationLanes(group));
  });
  return needs;
}

function laneGap(category, laneNeeds) {
  const laneCount = laneNeeds[category] || 0;
  const needed = laneCount > 1 ? (laneCount + 1) * RELATION_LANE_SPACING + RELATION_LANE_EDGE_PAD * 2 : 0;
  return Math.max(MIN_LANE_GAPS[category], needed);
}

function buildRows(laneNeeds) {
  const gaps = {
    redActionAbove: laneGap("redActionAbove", laneNeeds),
    redActionGap: laneGap("redActionGap", laneNeeds),
    speechGap: laneGap("speechGap", laneNeeds),
    blueActionGap: laneGap("blueActionGap", laneNeeds),
    blueActionBelow: laneGap("blueActionBelow", laneNeeds),
  };
  const rows = {
    timeline: { ...ROWS.timeline },
  };
  rows.redAction = {
    top: rows.timeline.top + rows.timeline.height + gaps.redActionAbove,
    height: ACTION_ROW_H,
    label: ROWS.redAction.label,
  };
  rows.redSpeech = {
    top: rows.redAction.top + rows.redAction.height + gaps.redActionGap,
    height: SPEECH_ROW_H,
    label: ROWS.redSpeech.label,
  };
  rows.blueSpeech = {
    top: rows.redSpeech.top + rows.redSpeech.height + gaps.speechGap,
    height: SPEECH_ROW_H,
    label: ROWS.blueSpeech.label,
  };
  rows.blueAction = {
    top: rows.blueSpeech.top + rows.blueSpeech.height + gaps.blueActionGap,
    height: ACTION_ROW_H,
    label: ROWS.blueAction.label,
  };
  const canvasHeight = rows.blueAction.top + rows.blueAction.height + gaps.blueActionBelow;
  return { rows, canvasHeight };
}

function buildGraphGeometry({ rows, actionEpisodes, conversations, timeToX, widthForRange, width }) {
  const baseSentenceRect = (sent, fallbackRange) => {
    const range = sent.time_range || fallbackRange || [0, 0];
    const speaker = normalizeSpeaker(sent.speaker);
    const row = speaker === "red_agent" ? rows.redSpeech : rows.blueSpeech;
    const left = timeToX(rangeStart(range));
    const widthPx = widthForRange(range);
    const top = row.top + (row.height - SPEECH_NODE_H) / 2;
    const height = SPEECH_NODE_H;
    return {
      left,
      right: left + widthPx,
      top,
      bottom: top + height,
      width: widthPx,
      height,
    };
  };
  const speechRects = expandSpeechRects(conversations, baseSentenceRect, timeToX, width);
  const sentenceRect = (sent, fallbackRange) =>
    speechRects.get(sent.speech_id) || baseSentenceRect(sent, fallbackRange);

  const conversationRects = new Map();
  for (const conv of conversations) {
    const range = conversationBounds(conv);
    const timeLeft = timeToX(rangeStart(range));
    const timeRight = timeLeft + widthForRange(range);
    const sentRects = (conv.sentences || []).map((sent) => sentenceRect(sent, range));
    const left = Math.min(timeLeft, ...sentRects.map((rect) => rect.left));
    const right = Math.max(timeRight, ...sentRects.map((rect) => rect.right));
    const top = Math.min(rows.redSpeech.top + 8, ...sentRects.map((rect) => rect.top)) - 10;
    const bottom = Math.max(rows.blueSpeech.top + rows.blueSpeech.height - 8, ...sentRects.map((rect) => rect.bottom)) + 10;
    conversationRects.set(conv.conversation_id, { left, right, top, bottom });
  }

  const layout = new Map();
  for (const action of actionEpisodes) {
    const range = action.time_range || [0, 0];
    const agent = normalizeSpeaker(action.agent);
    const row = agent === "red_agent" ? rows.redAction : rows.blueAction;
    const left = timeToX(rangeStart(range));
    const top = row.top + (row.height - ACTION_NODE_H) / 2;
    const widthPx = widthForRange(range);
    layout.set(action.action_episode_id, {
      left,
      right: left + widthPx,
      top,
      bottom: top + ACTION_NODE_H,
      type: "action",
      rowKey: agent === "red_agent" ? "redAction" : "blueAction",
    });
  }
  for (const conv of conversations) {
    const rect = conversationRects.get(conv.conversation_id);
    if (!rect) continue;
    layout.set(conv.conversation_id, {
      ...rect,
      type: "conversation",
      rowKey: "conversation",
    });
    for (const sent of conv.sentences || []) {
      const speechRect = sentenceRect(sent, conv.time_range);
      layout.set(sent.speech_id, {
        left: speechRect.left,
        right: speechRect.right,
        top: speechRect.top,
        bottom: speechRect.bottom,
        type: "speech",
        rowKey: normalizeSpeaker(sent.speaker) === "red_agent" ? "redSpeech" : "blueSpeech",
      });
    }
  }

  return { conversationRects, layout, sentenceRect, speechRects };
}

function routeNeedsGapLane(rel, src, dst, routeIndex, obstacles, anchorOffsets = {}) {
  if (!relationAllowsStraightPath(rel, src, dst)) return true;
  const cardinalCandidates = [
    sameRowStraightPoints(src, dst, routeIndex, 0, 1, anchorOffsets),
    crossRowVerticalPoints(src, dst, routeIndex, 0, 1, anchorOffsets),
  ].filter(Boolean);
  return !cardinalCandidates.some((points) => relationStraightPathIsClear(rel, points, obstacles));
}

function gapRoutePoints(rel, src, dst, laneIndex = 0, bounds = null, rows = ROWS, canvasHeight = CANVAS_H, laneCount = 1, anchorOffsets = {}) {
  const laneY = relationLaneYFromBounds(bounds || relationLaneBoundsY(rel, src, dst, rows, canvasHeight), laneIndex, laneCount);
  const start = connectionPoint(src, laneY, rectCenter(dst), anchorOffsets.sourceOffset || 0);
  const end = connectionPoint(dst, laneY, rectCenter(src), anchorOffsets.targetOffset || 0);
  const midStart = { x: start.x, y: laneY };
  const midEnd = { x: end.x, y: laneY };
  return [start, midStart, midEnd, end].filter((point, idx, arr) => {
    if (idx === 0) return true;
    const prev = arr[idx - 1];
    return Math.abs(point.x - prev.x) > 0.5 || Math.abs(point.y - prev.y) > 0.5;
  });
}

function assignRelationLanes(relations, layout, rows = ROWS, canvasHeight = CANVAS_H) {
  const candidates = relationCandidatesFromLayout(relations, layout, rows, canvasHeight);
  const anchorOffsetsByRelation = buildRelationAnchorOffsets(candidates);
  const laneCandidates = laneCandidatesWithActualSpans(candidates, layout, anchorOffsetsByRelation);

  const groups = new Map();
  laneCandidates.forEach((candidate) => {
    if (!groups.has(candidate.groupKey)) groups.set(candidate.groupKey, []);
    groups.get(candidate.groupKey).push(candidate);
  });

  const laneMetaByIndex = new Map();
  groups.forEach((group) => {
    const laneEnds = [];
    const assigned = [];
    const sorted = [...group].sort(
      (a, b) => a.spanStart - b.spanStart || a.spanEnd - b.spanEnd
    );
    sorted.forEach((candidate) => {
      let laneIndex = laneEnds.findIndex((end) => end <= candidate.spanStart);
      if (laneIndex < 0) {
        laneIndex = laneEnds.length;
      }
      laneEnds[laneIndex] = candidate.spanEnd;
      assigned.push({ candidate, laneIndex });
    });
    const laneCount = Math.max(1, laneEnds.length);
    assigned.forEach(({ candidate, laneIndex }) => {
      laneMetaByIndex.set(candidate.index, { laneIndex, laneCount });
    });
  });

  const routeById = new Map();
  candidates.forEach((candidate) => {
    const laneMeta = laneMetaByIndex.get(candidate.index) || { laneIndex: 0, laneCount: 1 };
    const anchorOffsets = anchorOffsetsByRelation.get(candidate.rel.relation_id) || {
      sourceOffset: 0,
      targetOffset: 0,
    };
    routeById.set(
      candidate.rel.relation_id,
      routeRelation(
        candidate.rel,
        candidate.src,
        candidate.dst,
        candidate.index,
        laneMeta.laneIndex,
        candidate.bounds,
        rows,
        canvasHeight,
        relationObstacles(layout, candidate.rel),
        laneMeta.laneCount,
        anchorOffsets
      )
    );
  });
  return routeById;
}

function routeRelation(rel, src, dst, routeIndex, laneIndex = 0, bounds = null, rows = ROWS, canvasHeight = CANVAS_H, obstacles = [], laneCount = 1, anchorOffsets = {}) {
  const isConversationLine =
    rel.relation_type === "conversation_conversation" ||
    rel.relation_type === "speech_speech";
  const isActionAction = rel.relation_type === "action_action";
  const color = isActionAction ? "#f59e0b" : isConversationLine ? "#b031d8" : "#1ca21c";
  const marker = isActionAction
    ? "url(#arrow-orange)"
    : isConversationLine
      ? "url(#arrow-purple)"
      : "url(#arrow-green)";

  if (!relationAllowsStraightPath(rel, src, dst)) {
    const points = gapRoutePoints(rel, src, dst, laneIndex, bounds, rows, canvasHeight, laneCount, anchorOffsets);
    return {
      color,
      marker,
      points,
      path: pathFromPoints(points),
      labelPosition: routeLabelPosition(points),
    };
  }

  const cardinalCandidates = [
    sameRowStraightPoints(src, dst, routeIndex, laneIndex, laneCount, anchorOffsets),
    crossRowVerticalPoints(src, dst, routeIndex, laneIndex, laneCount, anchorOffsets),
  ].filter(Boolean);
  const cardinal = cardinalCandidates.find((points) => relationStraightPathIsClear(rel, points, obstacles));
  if (cardinal) {
    return {
      color,
      marker,
      points: cardinal,
      path: pathFromPoints(cardinal),
      labelPosition: routeLabelPosition(cardinal),
    };
  }

  const points = gapRoutePoints(rel, src, dst, laneIndex, bounds, rows, canvasHeight, laneCount, anchorOffsets);
  return {
    color,
    marker,
    points,
    path: pathFromPoints(points),
    labelPosition: routeLabelPosition(points),
  };
}

function SessionUpload({ onSubmitFiles, onError, disabled }) {
  const folderRef = useRef(null);
  const datasetRef = useRef(null);
  const speechRef = useRef(null);

  const submitDatasetWithSpeech = () => {
    const datasetFiles = Array.from(datasetRef.current?.files || []);
    const speechFile = speechRef.current?.files?.[0];
    if (!speechFile) throw new Error("Provide speech_path (.json).");
    if (!datasetFiles.length) throw new Error("Provide a dataset folder.");
    const stem = detectSessionStem(datasetFiles);
    if (!stem) throw new Error("Could not find <map>_<timestamp>.json in the selected folder.");
    const speechStem = canonicalSessionStem(speechFile.name);
    if (speechStem !== stem) throw new Error(`speech_path basename (${speechStem}) must match ${stem}.`);
    onSubmitFiles(datasetFiles, speechFile);
  };

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
          h("input", { type: "file", ref: folderRef, disabled, multiple: true, webkitdirectory: "" })
        ),
        h(
          "button",
          {
            type: "button",
            disabled,
            onClick: () => onSubmitFiles(Array.from(folderRef.current?.files || []), null),
          },
          disabled ? "Running..." : "Run pipeline"
        )
      )
    ),
    h(
      "div",
      { className: "pipeline-row pipeline-row-secondary" },
      h(
        "div",
        { className: "pipeline-option-info" },
        h("div", { className: "pipeline-option-title" }, "Option 2"),
        h("p", null, "Upload a dataset folder plus an external speech file.")
      ),
      h(
        "div",
        { className: "pipeline-option-controls" },
        h(
          "label",
          { className: "file-picker" },
          h("span", null, "map_timestamp folder"),
          h("input", { type: "file", ref: datasetRef, disabled, multiple: true, webkitdirectory: "" })
        ),
        h(
          "label",
          { className: "file-picker" },
          h("span", null, "speech_path (.json)"),
          h("input", { type: "file", accept: ".json,application/json", ref: speechRef, disabled })
        ),
        h(
          "button",
          {
            type: "button",
            disabled,
            onClick: () => {
              try {
                submitDatasetWithSpeech();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              }
            },
          },
          disabled ? "Running..." : "Run pipeline"
        )
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
            h("div", { className: "pipeline-option-title" }, "Sample Mode"),
            h("p", null, "Select a sample session.")
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

function VideoStage({ videoSrc, duration, currentTime, onSeek, videoRef, onMediaError }) {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [videoRef]);

  if (!videoSrc) return null;

  const toggle = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await video.play();
    } else {
      video.pause();
    }
  };

  return h(
    "div",
    { className: "dependency-video-stage" },
    h(
      "div",
      { className: "dependency-video-wrap" },
      h("video", {
        key: videoSrc,
        ref: videoRef,
        src: videoSrc,
        type: "video/mp4",
        preload: "metadata",
        playsInline: true,
        className: "dependency-video",
        onTimeUpdate: (e) => onSeek(e.currentTarget.currentTime, false),
        onLoadedMetadata: (e) => onSeek(e.currentTarget.currentTime, false),
        onError: () => onMediaError("Could not load replay video."),
      })
    ),
    h(
      "div",
      { className: "playback-controls" },
      h("button", { type: "button", className: "btn-primary", onClick: toggle }, playing ? "Pause" : "Play"),
      h("span", { className: "playback-time" }, `${fmtTime(currentTime)} / ${fmtTime(duration)}`)
    )
  );
}

function FrameStrip({ frames, range, timeToX, mode = "range", onSeek, loading }) {
  const visibleFrames = mode === "timeline" ? frames : framesForRange(frames, range);
  const start = mode === "timeline" ? 0 : rangeStart(range);
  if (loading && (!frames || frames.length === 0)) {
    return h("div", { className: `frame-strip frame-strip-${mode} is-loading` }, "loading frames");
  }
  if (!visibleFrames.length) {
    return h("div", { className: `frame-strip frame-strip-${mode} is-empty` });
  }
  return h(
    "div",
    { className: `frame-strip frame-strip-${mode}` },
    visibleFrames.map((frame) => {
      const left =
        mode === "timeline"
          ? timeToX(frame.time) - LABEL_W - GRAPH_PAD
          : Math.max(0, (frame.time - start) * PX_PER_SECOND);
      return h("img", {
        key: `${mode}_${frame.time}`,
        src: frame.dataUrl,
        alt: "",
        className: "timeline-frame",
        style: {
          left: `${left}px`,
          width: `${FRAME_STEP_S * PX_PER_SECOND}px`,
        },
        onClick: onSeek ? () => onSeek(frame.time, true) : undefined,
        draggable: false,
      });
    })
  );
}

function HorizontalScrollbar({ scrollState, scrollRef, variant = "" }) {
  const trackRef = useRef(null);
  const max = Math.max(0, Number(scrollState.max || 0));
  const scrollWidth = Math.max(1, Number(scrollState.scrollWidth || 1));
  const clientWidth = Math.max(1, Number(scrollState.clientWidth || 1));
  const disabled = max <= 0;
  const thumbWidthPct = disabled ? 100 : clamp((clientWidth / scrollWidth) * 100, 5, 100);
  const thumbLeftPct = disabled ? 0 : (Number(scrollState.left || 0) / max) * (100 - thumbWidthPct);

  const scrollToTrackX = (clientX, thumbOffsetPx = 0) => {
    const track = trackRef.current;
    const el = scrollRef.current;
    if (!track || !el || disabled) return;
    const rect = track.getBoundingClientRect();
    const thumbWidthPx = (rect.width * thumbWidthPct) / 100;
    const travel = Math.max(1, rect.width - thumbWidthPx);
    const x = clamp(clientX - rect.left - thumbOffsetPx, 0, travel);
    el.scrollLeft = (x / travel) * max;
  };

  const startTrackDrag = (event) => {
    if (safeTagName(event.target) === "BUTTON") return;
    event.preventDefault();
    scrollToTrackX(event.clientX, ((trackRef.current?.getBoundingClientRect().width || 0) * thumbWidthPct) / 200);
    const move = (ev) => scrollToTrackX(ev.clientX, ((trackRef.current?.getBoundingClientRect().width || 0) * thumbWidthPct) / 200);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  const startThumbDrag = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const thumbRect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - thumbRect.left;
    const move = (ev) => scrollToTrackX(ev.clientX, offset);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  return h(
    "div",
    { className: `timeline-scrollbar ${variant} ${disabled ? "is-disabled" : ""}` },
    h(
      "div",
      {
        className: "timeline-scrollbar-track",
        ref: trackRef,
        onPointerDown: startTrackDrag,
      },
      h("div", {
        className: "timeline-scrollbar-thumb",
        style: {
          width: `${thumbWidthPct}%`,
          left: `${thumbLeftPct}%`,
        },
        onPointerDown: startThumbDrag,
      })
    )
  );
}

function RelationLayer({ relations, labelSets, layout, rows, canvasHeight, dragLink, onChangeLabel, onDelete, onMoveLabel }) {
  const routeById = useMemo(
    () => assignRelationLanes(relations, layout, rows, canvasHeight),
    [relations, layout, rows, canvasHeight]
  );

  const startLabelDrag = (event, relationId, route) => {
    if (["BUTTON", "SELECT", "OPTION"].includes(safeTagName(event.target))) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest(".dependency-canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev) => {
      onMoveLabel(
        relationId,
        constrainLabelPositionToRoute(
          {
            x: ev.clientX - rect.left,
            y: ev.clientY - rect.top,
          },
          route
        )
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener(
      "pointerup",
      () => window.removeEventListener("pointermove", move),
      { once: true }
    );
  };

  return h(
    Fragment,
    null,
    h(
      "svg",
      { className: "relation-svg", width: "100%", height: "100%" },
      h(
        "defs",
        null,
        h("marker", {
          id: "arrow-green",
          markerWidth: "20",
          markerHeight: "20",
          refX: "18",
          refY: "7",
          orient: "auto",
          markerUnits: "userSpaceOnUse",
        }, h("path", { d: "M0,0 L0,14 L19,7 z", fill: "#1ca21c" })),
        h("marker", {
          id: "arrow-orange",
          markerWidth: "20",
          markerHeight: "20",
          refX: "18",
          refY: "7",
          orient: "auto",
          markerUnits: "userSpaceOnUse",
        }, h("path", { d: "M0,0 L0,14 L19,7 z", fill: "#f59e0b" })),
        h("marker", {
          id: "arrow-purple",
          markerWidth: "20",
          markerHeight: "20",
          refX: "18",
          refY: "7",
          orient: "auto",
          markerUnits: "userSpaceOnUse",
        }, h("path", { d: "M0,0 L0,14 L19,7 z", fill: "#b031d8" }))
      ),
      relations.map((rel) => {
        const src = layout.get(rel.source_id);
        const dst = layout.get(rel.target_id);
        if (!src || !dst) return null;
        const route = routeById.get(rel.relation_id);
        if (!route) return null;
        return h("path", {
          key: rel.relation_id,
          d: route.path,
          fill: "none",
          stroke: route.color,
          strokeWidth: RELATION_STROKE_W,
          strokeLinejoin: "round",
          strokeLinecap: "round",
          markerEnd: route.marker,
        });
      }),
      dragLink &&
        (() => {
          const src = layout.get(dragLink.sourceId);
          const start = src
            ? edgePoint(src, { x: dragLink.currentX, y: dragLink.currentY })
            : { x: dragLink.currentX, y: dragLink.currentY };
          return h("line", {
            x1: start.x,
            y1: start.y,
            x2: dragLink.currentX,
            y2: dragLink.currentY,
            stroke: "#4fc3f7",
            strokeWidth: 2,
            strokeDasharray: "6 6",
          });
        })()
    ),
    relations.map((rel) => {
      const src = layout.get(rel.source_id);
      const dst = layout.get(rel.target_id);
      if (!src || !dst) return null;
      const route = routeById.get(rel.relation_id);
      if (!route) return null;
      const labelPos = constrainLabelPositionToRoute(rel.label_position || route.labelPosition, route);
      const options = labelSets[rel.relation_type] || DEFAULT_RELATION_LABEL_SETS[rel.relation_type] || ["unclear"];
      const labelValue = String(rel.label || options[0] || "").trim();
      const visibleOptions =
        labelValue && !options.includes(labelValue)
          ? [
              ...options.filter((option) => option !== "others"),
              labelValue,
              ...options.filter((option) => option === "others"),
            ]
          : options;
      return h(
        "div",
        {
          key: `${rel.relation_id}_label`,
          className: "relation-label",
          style: {
            left: `${labelPos.x}px`,
            top: `${labelPos.y}px`,
          },
        },
        h("span", {
          className: "relation-drag-handle",
          title: "Move label",
          onPointerDown: (e) => startLabelDrag(e, rel.relation_id, route),
        }, "::"),
        h(
          "select",
          {
            value: labelValue,
            onChange: (e) => {
              const nextLabel = e.target.value;
              if (nextLabel !== "others") {
                onChangeLabel(rel.relation_id, nextLabel);
                return;
              }
              const currentCustom = options.includes(labelValue) ? "" : labelValue;
              const customLabel = window.prompt("Enter the label of the relation", currentCustom);
              const normalizedLabel = String(customLabel || "").trim();
              if (normalizedLabel) {
                onChangeLabel(rel.relation_id, normalizedLabel);
              } else {
                e.target.value = labelValue;
              }
            },
            onPointerDown: (e) => e.stopPropagation(),
          },
          visibleOptions.map((option) => h("option", { key: option, value: option }, option))
        ),
        h("button", {
          type: "button",
          onPointerDown: (e) => e.stopPropagation(),
          onClick: () => onDelete(rel.relation_id),
        }, "x")
      );
    })
  );
}

function BlurNumberInput({ value, onCommit, ...props }) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);

  useEffect(() => {
    setDraft(external);
  }, [external]);

  const commit = () => {
    const text = String(draft).trim();
    if (!text) {
      setDraft(external);
      return;
    }
    const next = Number(text);
    if (!Number.isFinite(next)) {
      setDraft(external);
      return;
    }
    if (next !== Number(value)) {
      onCommit(next);
    }
  };

  return h("input", {
    ...props,
    type: "number",
    step: "any",
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") {
        setDraft(external);
        e.currentTarget.blur();
      }
    },
  });
}

function BlurTextArea({ value, onCommit, ...props }) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);

  useEffect(() => {
    setDraft(external);
  }, [external]);

  const commit = () => {
    if (draft !== external) {
      onCommit(draft);
    }
  };

  return h("textarea", {
    ...props,
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === "Escape") {
        setDraft(external);
        e.currentTarget.blur();
      }
    },
  });
}

function EditPanel({
  editor,
  action,
  conversation,
  speech,
  speechIndex,
  conversationIndex,
  onClose,
  onActionPatch,
  onSplitAction,
  onMergeAction,
  onDeleteAction,
  actionCanMergePrevious,
  actionCanMergeNext,
  onSpeechPatch,
  onConversationPatch,
  onSplitSpeech,
  onMergeSpeech,
  onDeleteSpeech,
  onSplitConversation,
  onMergeConversation,
  onAddAction,
  onAddSpeech,
  currentTime,
}) {
  const addPanel = h(
    "section",
    { className: "dependency-edit-panel" },
    h("div", { className: "dependency-edit-header" }, h("strong", null, "Add episode")),
    h(
      "div",
      { className: "add-episode-grid" },
      h("button", { type: "button", onClick: () => onAddAction("red_agent") }, "Add Red Agent Action"),
      h("button", { type: "button", onClick: () => onAddSpeech("red_agent") }, "Add Red Agent Speech"),
      h("button", { type: "button", onClick: () => onAddAction("blue_agent") }, "Add Blue Agent Action"),
      h("button", { type: "button", onClick: () => onAddSpeech("blue_agent") }, "Add Blue Agent Speech")
    )
  );

  if (!editor) return addPanel;

  if (editor.type === "action" && action) {
    const range = action.time_range || [0, 0];
    return h(
      "section",
      { className: "dependency-edit-panel" },
      h("div", { className: "dependency-edit-header" }, h("strong", null, "Edit action"), h("button", { type: "button", onClick: onClose }, "Close")),
      h(
        "div",
        { className: "edit-grid" },
        h(
          "label",
          null,
          "Start",
          h(BlurNumberInput, {
            value: rangeStart(range),
            onCommit: (value) =>
              onActionPatch(action.action_episode_id, {
                time_range: [value, rangeEnd(range)],
              }),
          })
        ),
        h(
          "label",
          null,
          "End",
          h(BlurNumberInput, {
            value: rangeEnd(range),
            onCommit: (value) =>
              onActionPatch(action.action_episode_id, {
                time_range: [rangeStart(range), value],
              }),
          })
        )
      ),
      h(
        "label",
        null,
        "Description",
        h(BlurTextArea, {
          value: action.title || "",
          onCommit: (value) => onActionPatch(action.action_episode_id, { title: value }),
        })
      ),
      h(
        "div",
        { className: "dependency-edit-actions" },
        h("button", { type: "button", onClick: () => onSplitAction(action.action_episode_id) }, "Split action"),
        h("button", { type: "button", disabled: !actionCanMergePrevious, onClick: () => onMergeAction(action.action_episode_id, "previous") }, "Merge previous action"),
        h("button", { type: "button", disabled: !actionCanMergeNext, onClick: () => onMergeAction(action.action_episode_id, "next") }, "Merge next action"),
        h("button", { type: "button", onClick: () => onDeleteAction(action.action_episode_id) }, "Delete action")
      )
    );
  }

  if (editor.type === "speech" && speech && conversation) {
    const range = speech.time_range || [0, 0];
    return h(
      "section",
      { className: "dependency-edit-panel" },
      h("div", { className: "dependency-edit-header" }, h("strong", null, "Edit speech"), h("button", { type: "button", onClick: onClose }, "Close")),
      h(
        "div",
        { className: "edit-grid" },
        h(
          "label",
          null,
          "Speaker",
          h(
            "select",
            {
              value: normalizeSpeaker(speech.speaker),
              onChange: (e) => onSpeechPatch(conversation.conversation_id, speech.speech_id, { speaker: e.target.value }),
            },
            h("option", { value: "red_agent" }, "red_agent"),
            h("option", { value: "blue_agent" }, "blue_agent")
          )
        ),
        h(
          "label",
          null,
          "Role",
          h(
            "select",
            {
              value: speech.conversation_role || "initiating_conversation",
              onChange: (e) =>
                onSpeechPatch(conversation.conversation_id, speech.speech_id, {
                  conversation_role: e.target.value,
                }),
            },
            CONVERSATION_ROLE_OPTIONS.map((value) => h("option", { key: value, value }, value))
          )
        ),
        h(
          "label",
          null,
          "Start",
          h(BlurNumberInput, {
            value: rangeStart(range),
            onCommit: (value) =>
              onSpeechPatch(conversation.conversation_id, speech.speech_id, {
                time_range: [value, rangeEnd(range)],
              }),
          })
        ),
        h(
          "label",
          null,
          "End",
          h(BlurNumberInput, {
            value: rangeEnd(range),
            onCommit: (value) =>
              onSpeechPatch(conversation.conversation_id, speech.speech_id, {
                time_range: [rangeStart(range), value],
              }),
          })
        )
      ),
      h(
        "label",
        null,
        "Text",
        h(BlurTextArea, {
          value: speech.text || "",
          onCommit: (value) => onSpeechPatch(conversation.conversation_id, speech.speech_id, { text: value }),
        })
      ),
      h(
        "div",
        { className: "dependency-edit-actions" },
        h("button", { type: "button", onClick: () => onSplitSpeech(conversation.conversation_id, speech.speech_id) }, "Split speech"),
        h("button", { type: "button", disabled: speechIndex <= 0, onClick: () => onMergeSpeech(conversation.conversation_id, speech.speech_id, "previous") }, "Merge previous speech"),
        h("button", { type: "button", disabled: speechIndex >= (conversation.sentences || []).length - 1, onClick: () => onMergeSpeech(conversation.conversation_id, speech.speech_id, "next") }, "Merge next speech"),
        h("button", { type: "button", onClick: () => onDeleteSpeech(conversation.conversation_id, speech.speech_id) }, "Delete speech")
      )
    );
  }

  if (editor.type === "conversation" && conversation) {
    const range = conversation.time_range || conversationBounds(conversation);
    return h(
      "section",
      { className: "dependency-edit-panel" },
      h("div", { className: "dependency-edit-header" }, h("strong", null, "Edit conversation"), h("button", { type: "button", onClick: onClose }, "Close")),
      h(
        "div",
        { className: "edit-grid" },
        h(
          "label",
          null,
          "Start",
          h(BlurNumberInput, {
            value: rangeStart(range),
            onCommit: (value) =>
              onConversationPatch(conversation.conversation_id, {
                time_range: [value, rangeEnd(range)],
              }),
          })
        ),
        h(
          "label",
          null,
          "End",
          h(BlurNumberInput, {
            value: rangeEnd(range),
            onCommit: (value) =>
              onConversationPatch(conversation.conversation_id, {
                time_range: [rangeStart(range), value],
              }),
          })
        )
      ),
      h(
        "div",
        { className: "dependency-edit-actions" },
        h("button", { type: "button", disabled: (conversation.sentences || []).length < 2, onClick: () => onSplitConversation(conversation.conversation_id) }, "Split conversation"),
        h("button", { type: "button", disabled: conversationIndex <= 0, onClick: () => onMergeConversation(conversation.conversation_id, "previous") }, "Merge previous"),
        h("button", { type: "button", onClick: () => onMergeConversation(conversation.conversation_id, "next") }, "Merge next")
      )
    );
  }

  return addPanel;
}

function DependencyGraph({
  manifest,
  actionEpisodes,
  relations,
  labelSets,
  videoSrc,
  videoRef,
  currentTime,
  onSeek,
  onMediaError,
  videoFrames,
  framesLoading,
  onActionEpisodesChange,
  onConversationsChange,
  onRelationsChange,
}) {
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const [dragLink, setDragLink] = useState(null);
  const [scrollState, setScrollState] = useState({ left: 0, max: 0, scrollWidth: 0, clientWidth: 0 });
  const [editor, setEditor] = useState(null);
  const conversations = useMemo(() => conversationsFromManifest(manifest), [manifest]);
  const duration = useMemo(
    () => manifestDuration(manifest, conversations, actionEpisodes),
    [manifest, conversations, actionEpisodes]
  );
  const timelineTicks = useMemo(() => {
    const maxT = Math.max(0, Number(duration || 0));
    const step = 5;
    const ticks = [];
    for (let t = 0; t <= maxT + 0.001; t += step) {
      ticks.push(Number(t.toFixed(2)));
    }
    if (!ticks.length || ticks[ticks.length - 1] < maxT) ticks.push(Number(maxT.toFixed(2)));
    return ticks;
  }, [duration]);
  const width = Math.max(1180, LABEL_W + GRAPH_PAD * 2 + duration * PX_PER_SECOND + 220);
  const timeToX = useCallback((t) => LABEL_W + GRAPH_PAD + Number(t || 0) * PX_PER_SECOND, []);
  const widthForRange = useCallback((range) => timeWidth(range), []);
  const baseRowLayout = useMemo(() => buildRows(EMPTY_LANE_NEEDS), []);
  const baseGeometry = useMemo(
    () =>
      buildGraphGeometry({
        rows: baseRowLayout.rows,
        actionEpisodes,
        conversations,
        timeToX,
        widthForRange,
        width,
      }),
    [actionEpisodes, baseRowLayout.rows, conversations, timeToX, width, widthForRange]
  );
  const laneNeeds = useMemo(
    () => estimateLaneNeedsFromLayout(relations, baseGeometry.layout, baseRowLayout.rows, baseRowLayout.canvasHeight),
    [baseGeometry.layout, baseRowLayout.canvasHeight, baseRowLayout.rows, relations]
  );
  const rowLayout = useMemo(() => buildRows(laneNeeds), [laneNeeds]);
  const rows = rowLayout.rows;
  const canvasHeight = rowLayout.canvasHeight;
  const geometry = useMemo(
    () =>
      buildGraphGeometry({
        rows,
        actionEpisodes,
        conversations,
        timeToX,
        widthForRange,
        width,
      }),
    [actionEpisodes, conversations, rows, timeToX, width, widthForRange]
  );
  const { conversationRects, layout, sentenceRect } = geometry;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollState({
      left: el.scrollLeft,
      max: Math.max(0, el.scrollWidth - el.clientWidth),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  }, []);

  useEffect(() => {
    updateScrollState();
    const raf = requestAnimationFrame(updateScrollState);
    window.addEventListener("resize", updateScrollState);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [actionEpisodes.length, conversations.length, duration, updateScrollState, width]);

  const scrubToClientX = useCallback(
    (clientX) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clientX - rect.left;
      const t = (x - LABEL_W - GRAPH_PAD) / PX_PER_SECOND;
      onSeek(Math.max(0, Math.min(duration, t)), true);
    },
    [duration, onSeek]
  );

  const startTimelineScrub = useCallback(
    (e) => {
      if (["BUTTON", "SELECT", "INPUT"].includes(safeTagName(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      scrubToClientX(e.clientX);
      const onMove = (ev) => scrubToClientX(ev.clientX);
      window.addEventListener("pointermove", onMove);
      window.addEventListener(
        "pointerup",
        () => window.removeEventListener("pointermove", onMove),
        { once: true }
      );
    },
    [scrubToClientX]
  );

  const selectedAction =
    editor?.type === "action"
      ? actionEpisodes.find((item) => item.action_episode_id === editor.id)
      : null;
  let selectedConversation = null;
  let selectedConversationIndex = -1;
  let selectedSpeech = null;
  let selectedSpeechIndex = -1;
  if (editor?.type === "conversation") {
    selectedConversationIndex = conversations.findIndex((conv) => conv.conversation_id === editor.id);
    selectedConversation = selectedConversationIndex >= 0 ? conversations[selectedConversationIndex] : null;
  }
  if (editor?.type === "speech") {
    for (let cIdx = 0; cIdx < conversations.length; cIdx += 1) {
      const conv = conversations[cIdx];
      const sIdx = (conv.sentences || []).findIndex((sent) => sent.speech_id === editor.id);
      if (sIdx >= 0) {
        selectedConversation = conv;
        selectedConversationIndex = cIdx;
        selectedSpeech = conv.sentences[sIdx];
        selectedSpeechIndex = sIdx;
        break;
      }
    }
  }
  const actionNeighborId = (actionId, direction) => {
    const action = actionEpisodes.find((item) => item.action_episode_id === actionId);
    if (!action) return null;
    const agent = normalizeSpeaker(action.agent);
    const sameAgentActions = sortActionEpisodes(
      actionEpisodes.filter((item) => normalizeSpeaker(item.agent) === agent)
    );
    const idx = sameAgentActions.findIndex((item) => item.action_episode_id === actionId);
    const otherIdx = direction === "previous" ? idx - 1 : idx + 1;
    return otherIdx >= 0 && otherIdx < sameAgentActions.length
      ? sameAgentActions[otherIdx].action_episode_id
      : null;
  };
  const selectedActionCanMergePrevious = selectedAction
    ? Boolean(actionNeighborId(selectedAction.action_episode_id, "previous"))
    : false;
  const selectedActionCanMergeNext = selectedAction
    ? Boolean(actionNeighborId(selectedAction.action_episode_id, "next"))
    : false;

  const newRangeAtPlayhead = (lengthS) => {
    const start = Math.max(0, Number(currentTime || 0));
    const end = Math.max(start + 0.01, start + lengthS);
    return [Number(start.toFixed(2)), Number(end.toFixed(2))];
  };

  const addAction = (agent) => {
    const range = newRangeAtPlayhead(2);
    const id = `manual_action_${agent}_${Date.now()}`;
    const action = {
      action_episode_id: id,
      agent,
      title: `${agent} action`,
      time_range: range,
    };
    onActionEpisodesChange(sortActionEpisodes([...actionEpisodes, action]));
    setEditor({ type: "action", id });
  };

  const addSpeech = (agent) => {
    const range = newRangeAtPlayhead(1.5);
    const start = rangeStart(range);
    const sent = {
      speaker: agent,
      text: "",
      time_range: range,
      conversation_role: "initiating_conversation",
      communication_function: "share_information",
    };
    let inserted = false;
    const nextConversations = conversations.map((conv) => {
      const convRange = conversationBounds(conv);
      if (!inserted && start >= rangeStart(convRange) && start <= rangeEnd(convRange)) {
        inserted = true;
        const sentences = [...(conv.sentences || []), sent].sort(
          (a, b) => rangeStart(a.time_range) - rangeStart(b.time_range)
        );
        const nextConv = { ...conv, sentences };
        nextConv.time_range = conversationBounds(nextConv, false);
        return nextConv;
      }
      return conv;
    });
    if (!inserted) {
      nextConversations.push({
        conversation_id: `conv_${String(nextConversations.length).padStart(3, "0")}`,
        time_range: range,
        action_window: [rangeStart(range), rangeEnd(range) + 5],
        follow_label: "unclear",
        collapsed: false,
        sentences: [sent],
      });
    }
    const normalized = renumberConversations(
      nextConversations.sort(
        (a, b) => rangeStart(conversationBounds(a)) - rangeStart(conversationBounds(b))
      )
    );
    const created = normalized
      .flatMap((conv) => conv.sentences || [])
      .find(
        (item) =>
          normalizeSpeaker(item.speaker) === agent &&
          Math.abs(rangeStart(item.time_range) - rangeStart(range)) < 0.001 &&
          Math.abs(rangeEnd(item.time_range) - rangeEnd(range)) < 0.001
      );
    onConversationsChange(normalized);
    if (created) {
      setEditor({ type: "speech", id: created.speech_id });
    }
  };

  const patchAction = (actionId, patch) => {
    onActionEpisodesChange(
      actionEpisodes.map((item) => {
        if (item.action_episode_id !== actionId) return item;
        const next = { ...item, ...patch };
        if (patch.time_range) {
          const start = Number(patch.time_range[0]);
          const end = Number(patch.time_range[1]);
          next.time_range = [Math.min(start, end), Math.max(start, end)];
        }
        return next;
      })
    );
  };

  const splitAction = (actionId) => {
    const idx = actionEpisodes.findIndex((item) => item.action_episode_id === actionId);
    if (idx < 0) return;
    const action = actionEpisodes[idx];
    const range = action.time_range || [0, 0];
    const start = rangeStart(range);
    const end = rangeEnd(range);
    if (end - start <= 0.02) return;
    const mid = (start + end) / 2;
    const rightId = `${action.action_episode_id}_b_${Date.now()}`;
    const left = {
      ...action,
      time_range: [start, mid],
    };
    const right = {
      ...action,
      action_episode_id: rightId,
      time_range: [mid, end],
    };
    onActionEpisodesChange(sortActionEpisodes([
      ...actionEpisodes.slice(0, idx),
      left,
      right,
      ...actionEpisodes.slice(idx + 1),
    ]));
    setEditor({ type: "action", id: action.action_episode_id });
  };

  const mergeAction = (actionId, direction) => {
    const otherId = actionNeighborId(actionId, direction);
    if (!otherId) return;
    const action = actionEpisodes.find((item) => item.action_episode_id === actionId);
    const other = actionEpisodes.find((item) => item.action_episode_id === otherId);
    if (!action || !other) return;
    const first = rangeStart(action.time_range) <= rangeStart(other.time_range) ? action : other;
    const second = first === action ? other : action;
    const merged = {
      ...first,
      title: mergedActionTitle(first, second),
      time_range: [
        Math.min(rangeStart(first.time_range), rangeStart(second.time_range)),
        Math.max(rangeEnd(first.time_range), rangeEnd(second.time_range)),
      ],
    };
    const actionRemap = new Map([
      [first.action_episode_id, merged.action_episode_id],
      [second.action_episode_id, merged.action_episode_id],
    ]);
    onActionEpisodesChange(
      sortActionEpisodes([
        ...actionEpisodes.filter(
          (item) =>
            item.action_episode_id !== first.action_episode_id &&
            item.action_episode_id !== second.action_episode_id
        ),
        merged,
      ])
    );
    onRelationsChange(remapRelations(relations, { action: actionRemap }));
    setEditor({ type: "action", id: merged.action_episode_id });
  };

  const deleteAction = (actionId) => {
    onActionEpisodesChange(actionEpisodes.filter((item) => item.action_episode_id !== actionId));
    onRelationsChange(removeRelationsForNode(relations, "action", actionId));
    setEditor(null);
  };

  const patchSpeech = (convId, speechNodeId, patch) => {
    const nextConversations = conversations.map((conv) => {
      if (conv.conversation_id !== convId) return conv;
      const sentences = (conv.sentences || []).map((sent) => {
        if (sent.speech_id !== speechNodeId) return sent;
        const next = { ...sent, ...patch };
        if (patch.time_range) {
          const start = Number(patch.time_range[0]);
          const end = Number(patch.time_range[1]);
          next.time_range = [Math.min(start, end), Math.max(start, end)];
        }
        return next;
      });
      const nextConv = { ...conv, sentences };
      nextConv.time_range = conversationBounds(nextConv, false);
      return nextConv;
    });
    onConversationsChange(nextConversations);
  };

  const patchConversation = (convId, patch) => {
    onConversationsChange(
      conversations.map((conv) => {
        if (conv.conversation_id !== convId) return conv;
        const next = { ...conv, ...patch };
        if (patch.time_range) {
          const start = Number(patch.time_range[0]);
          const end = Number(patch.time_range[1]);
          next.time_range = [Math.min(start, end), Math.max(start, end)];
        }
        return next;
      })
    );
  };

  const splitSpeech = (convId, speechNodeId) => {
    const speechRemap = new Map();
    const nextConversations = conversations.map((conv) => {
      if (conv.conversation_id !== convId) return conv;
      const idx = (conv.sentences || []).findIndex((sent) => sent.speech_id === speechNodeId);
      if (idx < 0) return conv;
      const sent = conv.sentences[idx];
      const range = sent.time_range || [0, 0];
      const midT = (rangeStart(range) + rangeEnd(range)) / 2;
      const words = String(sent.text || "").split(/\s+/).filter(Boolean);
      const midWord = Math.max(1, Math.floor(words.length / 2));
      const leftText = words.length > 1 ? words.slice(0, midWord).join(" ") : String(sent.text || "");
      const rightText = words.length > 1 ? words.slice(midWord).join(" ") : "";
      const left = {
        ...sent,
        text: leftText,
        time_range: [rangeStart(range), midT],
        speech_id: `${sent.speech_id}_a_${Date.now()}`,
      };
      const right = {
        ...sent,
        text: rightText,
        time_range: [midT, rangeEnd(range)],
        speech_id: `${sent.speech_id}_b_${Date.now()}`,
      };
      speechRemap.set(sent.speech_id, left.speech_id);
      const nextConv = {
        ...conv,
        sentences: [...conv.sentences.slice(0, idx), left, right, ...conv.sentences.slice(idx + 1)],
      };
      nextConv.time_range = conversationBounds(nextConv, false);
      return nextConv;
    });
    onConversationsChange(nextConversations);
    if (speechRemap.size) {
      onRelationsChange(remapRelations(relations, { speech: speechRemap }));
    }
  };

  const mergeSpeech = (convId, speechNodeId, direction) => {
    const speechRemap = new Map();
    const nextConversations = conversations.map((conv) => {
      if (conv.conversation_id !== convId) return conv;
      const idx = (conv.sentences || []).findIndex((sent) => sent.speech_id === speechNodeId);
      const otherIdx = direction === "previous" ? idx - 1 : idx + 1;
      if (idx < 0 || otherIdx < 0 || otherIdx >= conv.sentences.length) return conv;
      const firstIdx = Math.min(idx, otherIdx);
      const secondIdx = Math.max(idx, otherIdx);
      const first = conv.sentences[firstIdx];
      const second = conv.sentences[secondIdx];
      const merged = {
        ...first,
        text: [first.text, second.text].map((t) => String(t || "").trim()).filter(Boolean).join(" "),
        time_range: [
          Math.min(rangeStart(first.time_range), rangeStart(second.time_range)),
          Math.max(rangeEnd(first.time_range), rangeEnd(second.time_range)),
        ],
      };
      speechRemap.set(first.speech_id, merged.speech_id);
      speechRemap.set(second.speech_id, merged.speech_id);
      const nextConv = {
        ...conv,
        sentences: [
          ...conv.sentences.slice(0, firstIdx),
          merged,
          ...conv.sentences.slice(secondIdx + 1),
        ],
      };
      nextConv.time_range = conversationBounds(nextConv, false);
      return nextConv;
    });
    onConversationsChange(nextConversations);
    if (speechRemap.size) {
      onRelationsChange(remapRelations(relations, { speech: speechRemap }));
    }
  };

  const deleteSpeech = (convId, speechNodeId) => {
    const conv = conversations.find((item) => item.conversation_id === convId);
    if (!conv) return;
    const nextSentences = (conv.sentences || []).filter((sent) => sent.speech_id !== speechNodeId);
    if (nextSentences.length) {
      const nextConversations = conversations.map((item) => {
        if (item.conversation_id !== convId) return item;
        const nextConv = { ...item, sentences: nextSentences };
        nextConv.time_range = conversationBounds(nextConv, false);
        return nextConv;
      });
      onConversationsChange(nextConversations);
      onRelationsChange(removeRelationsForNode(relations, "speech", speechNodeId));
    } else {
      const keptConversations = conversations.filter((item) => item.conversation_id !== convId);
      const nextConversations = renumberConversations(keptConversations);
      const conversationRemap = new Map();
      keptConversations.forEach((oldConv, idx) => {
        conversationRemap.set(oldConv.conversation_id, nextConversations[idx]?.conversation_id || oldConv.conversation_id);
      });
      const filteredRelations = removeRelationsForNode(
        removeRelationsForNode(relations, "speech", speechNodeId),
        "conversation",
        convId
      );
      onConversationsChange(nextConversations);
      onRelationsChange(remapRelations(filteredRelations, { conversation: conversationRemap }));
    }
    setEditor(null);
  };

  const splitConversation = (convId) => {
    const idx = conversations.findIndex((conv) => conv.conversation_id === convId);
    if (idx < 0) return;
    const conv = conversations[idx];
    const sentences = conv.sentences || [];
    if (sentences.length < 2) return;
    const splitAt = Math.max(1, Math.floor(sentences.length / 2));
    const left = { ...conv, sentences: sentences.slice(0, splitAt) };
    const right = { ...conv, sentences: sentences.slice(splitAt) };
    left.time_range = conversationBounds(left, false);
    right.time_range = conversationBounds(right, false);
    const nextConversations = renumberConversations([
      ...conversations.slice(0, idx),
      left,
      right,
      ...conversations.slice(idx + 1),
    ]);
    const conversationRemap = new Map();
    conversations.forEach((oldConv, oldIdx) => {
      const nextIdx = oldIdx <= idx ? oldIdx : oldIdx + 1;
      conversationRemap.set(oldConv.conversation_id, nextConversations[nextIdx]?.conversation_id || oldConv.conversation_id);
    });
    onConversationsChange(nextConversations);
    onRelationsChange(remapRelations(relations, { conversation: conversationRemap }));
  };

  const mergeConversation = (convId, direction) => {
    const idx = conversations.findIndex((conv) => conv.conversation_id === convId);
    const otherIdx = direction === "previous" ? idx - 1 : idx + 1;
    if (idx < 0 || otherIdx < 0 || otherIdx >= conversations.length) return;
    const firstIdx = Math.min(idx, otherIdx);
    const secondIdx = Math.max(idx, otherIdx);
    const first = conversations[firstIdx];
    const second = conversations[secondIdx];
    const merged = {
      ...first,
      sentences: [...(first.sentences || []), ...(second.sentences || [])],
    };
    merged.time_range = conversationBounds(merged, false);
    const nextConversations = renumberConversations([
      ...conversations.slice(0, firstIdx),
      merged,
      ...conversations.slice(secondIdx + 1),
    ]);
    const conversationRemap = new Map();
    conversations.forEach((oldConv, oldIdx) => {
      let nextIdx = oldIdx;
      if (oldIdx === firstIdx || oldIdx === secondIdx) {
        nextIdx = firstIdx;
      } else if (oldIdx > secondIdx) {
        nextIdx = oldIdx - 1;
      }
      conversationRemap.set(oldConv.conversation_id, nextConversations[nextIdx]?.conversation_id || oldConv.conversation_id);
    });
    onConversationsChange(nextConversations);
    onRelationsChange(remapRelations(relations, { conversation: conversationRemap }));
  };

  const addRelation = useCallback(
    (source, target) => {
      if (!source || !target || source.id === target.id) return;
      if (source.type === "conversation" && target.type === "conversation") return;
      const relType = relationType(source.type, target.type);
      const options = labelSets[relType] || DEFAULT_RELATION_LABEL_SETS[relType] || ["unclear"];
      const exists = relations.some(
        (rel) =>
          rel.source_id === source.id &&
          rel.source_type === source.type &&
          rel.target_id === target.id &&
          rel.target_type === target.type
      );
      if (exists) return;
      onRelationsChange([
        ...relations,
        {
          relation_id: `dep_rel_${Date.now()}_${relations.length + 1}`,
          source_id: source.id,
          source_type: source.type,
          target_id: target.id,
          target_type: target.type,
          relation_type: relType,
          label: options[0] || "unclear",
        },
      ]);
    },
    [labelSets, onRelationsChange, relations]
  );

  useEffect(() => {
    if (!dragLink) return undefined;
    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDragLink((prev) =>
        prev
          ? {
              ...prev,
              currentX: e.clientX - rect.left,
              currentY: e.clientY - rect.top,
            }
          : prev
      );
    };
    const onUp = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-node-id]");
      if (target) {
        addRelation(
          { id: dragLink.sourceId, type: dragLink.sourceType },
          { id: target.dataset.nodeId, type: target.dataset.nodeType }
        );
      }
      setDragLink(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [addRelation, dragLink]);

  const startDrag = (e, id, type) => {
    if (["VIDEO", "BUTTON", "SELECT", "INPUT", "TEXTAREA"].includes(safeTagName(e.target))) return;
    const sourceRect = layout.get(id);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!sourceRect || !rect) return;
    e.preventDefault();
    setDragLink({
      sourceId: id,
      sourceType: type,
      currentX: e.clientX - rect.left,
      currentY: e.clientY - rect.top,
    });
  };

  const playheadX = timeToX(currentTime);
  const editPanel = h(EditPanel, {
    editor,
    action: selectedAction,
    conversation: selectedConversation,
    speech: selectedSpeech,
    speechIndex: selectedSpeechIndex,
    conversationIndex: selectedConversationIndex,
    onClose: () => setEditor(null),
    onActionPatch: patchAction,
    onSplitAction: splitAction,
    onMergeAction: mergeAction,
    onDeleteAction: deleteAction,
    actionCanMergePrevious: selectedActionCanMergePrevious,
    actionCanMergeNext: selectedActionCanMergeNext,
    onSpeechPatch: patchSpeech,
    onConversationPatch: patchConversation,
    onSplitSpeech: splitSpeech,
    onMergeSpeech: mergeSpeech,
    onDeleteSpeech: deleteSpeech,
    onSplitConversation: splitConversation,
    onMergeConversation: mergeConversation,
    onAddAction: addAction,
    onAddSpeech: addSpeech,
    currentTime,
  });

  return h(
    "section",
    { className: "dependency-panel" },
    h(
      "div",
      { className: "dependency-panel-header" },
      h("h2", null, "Dependency graph")
    ),
    h(
      "div",
      { className: "dependency-top-workspace" },
      h(VideoStage, {
        videoSrc,
        duration,
        currentTime,
        onSeek,
        videoRef,
        onMediaError,
      }),
      h("div", { className: "dependency-edit-slot" }, editPanel)
    ),
    h(HorizontalScrollbar, {
      scrollState,
      scrollRef,
      variant: "timeline-scrollbar-top",
    }),
    h(
      "div",
      {
        className: "dependency-scroll",
        ref: scrollRef,
        onScroll: updateScrollState,
        onWheel: (e) => {
          const el = scrollRef.current;
          if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          el.scrollLeft += e.deltaY;
          updateScrollState();
        },
      },
      h(
        "div",
        {
          className: "dependency-canvas",
          ref: canvasRef,
          style: { width: `${width}px`, height: `${canvasHeight}px` },
        },
        Object.entries(rows).map(([key, row]) =>
          h(
            Fragment,
            { key },
            h("div", {
              className: `row-band row-band-${key}`,
              style: { top: `${row.top}px`, height: `${row.height}px` },
            }),
            h(
              "div",
              { className: `row-label row-label-${key}`, style: { top: `${row.top}px`, height: `${row.height}px` } },
              row.label
            )
          )
        ),
        h(
          "div",
          {
            className: "timeline-ruler",
            style: { top: `${rows.timeline.top}px`, height: `${rows.timeline.height}px` },
            onPointerDown: startTimelineScrub,
          },
          timelineTicks.map((tick) =>
            h(
              "button",
              {
                key: `tick_${tick}`,
                type: "button",
                className: "timeline-tick",
                style: {
                  left: `${timeToX(tick)}px`,
                  height: `${rows.timeline.height}px`,
                },
                onClick: () => onSeek(tick, true),
              },
              h("span", null, fmtTime(tick))
            )
          )
        ),
        h(
          "div",
          {
            className: "timeline-filmstrip",
            style: {
              left: `${LABEL_W + GRAPH_PAD}px`,
              top: `${rows.timeline.top + 28}px`,
              width: `${Math.max(1, duration * PX_PER_SECOND)}px`,
            },
          },
          h(FrameStrip, {
            frames: videoFrames,
            range: [0, duration],
            timeToX,
            mode: "timeline",
            onSeek,
            loading: framesLoading,
          })
        ),
        h("div", {
          className: "playhead",
          style: { left: `${playheadX}px` },
          title: "Drag to scrub video",
          onPointerDown: startTimelineScrub,
        }),
        h(RelationLayer, {
          relations,
          labelSets,
          layout,
          rows,
          canvasHeight,
          dragLink,
          onChangeLabel: (relationId, label) =>
            onRelationsChange(relations.map((rel) => (rel.relation_id === relationId ? { ...rel, label } : rel))),
          onMoveLabel: (relationId, labelPosition) =>
            onRelationsChange(
              relations.map((rel) =>
                rel.relation_id === relationId ? { ...rel, label_position: labelPosition } : rel
              )
            ),
          onDelete: (relationId) =>
            onRelationsChange(relations.filter((rel) => rel.relation_id !== relationId)),
        }),
        actionEpisodes.map((action, idx) => {
          const range = action.time_range || [0, 0];
          const agent = normalizeSpeaker(action.agent);
          const row = agent === "red_agent" ? rows.redAction : rows.blueAction;
          return h(
            "article",
            {
              key: action.action_episode_id,
              className: `graph-node action-node ${agent === "red_agent" ? "red-node" : "blue-node"}`,
              "data-node-id": action.action_episode_id,
              "data-node-type": "action",
              style: {
                left: `${timeToX(rangeStart(range))}px`,
                top: `${row.top + (row.height - ACTION_NODE_H) / 2}px`,
                width: `${widthForRange(range)}px`,
                minHeight: `${ACTION_NODE_H}px`,
              },
              onPointerDown: (e) => startDrag(e, action.action_episode_id, "action"),
              onClick: (e) => {
                e.stopPropagation();
                setEditor({ type: "action", id: action.action_episode_id });
              },
            },
            h(
              "div",
              { className: "action-description" },
              action.title || `${agent} action`
            ),
            h(
              "span",
              { className: "action-time-label" },
              rangeText(range)
            )
          );
        }),
        conversations.map((conv) => {
          const rect = conversationRects.get(conv.conversation_id);
          if (!rect) return null;
          return h(
            "article",
            {
              key: conv.conversation_id,
              className: "graph-node conversation-node",
              "data-node-id": conv.conversation_id,
              "data-node-type": "conversation",
              style: {
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.right - rect.left}px`,
                height: `${rect.bottom - rect.top}px`,
              },
              onPointerDown: (e) => startDrag(e, conv.conversation_id, "conversation"),
              onClick: (e) => {
                e.stopPropagation();
                setEditor({ type: "conversation", id: conv.conversation_id });
              },
            },
            h("div", { className: "conversation-node-title" }, conv.conversation_id)
          );
        }),
        conversations.flatMap((conv) =>
          (conv.sentences || []).map((sent, sentIdx) => {
            const range = sent.time_range || conv.time_range || [0, 0];
            const speaker = normalizeSpeaker(sent.speaker);
            const rect = sentenceRect(sent, conv.time_range);
            return h(
              "div",
              {
                key: `${conv.conversation_id}_${sentIdx}`,
                className: `speech-box ${speaker === "red_agent" ? "red-speech" : "blue-speech"}`,
                "data-node-id": sent.speech_id,
                "data-node-type": "speech",
                style: {
                  left: `${rect.left}px`,
                  top: `${rect.top}px`,
                  width: `${rect.width}px`,
                  minHeight: `${rect.height}px`,
                },
                onPointerDown: (e) => startDrag(e, sent.speech_id, "speech"),
                onClick: (e) => {
                  e.stopPropagation();
                  setEditor({ type: "speech", id: sent.speech_id });
                },
              },
              h("strong", null, String(sent.speaker || speaker)),
              h("span", null, String(sent.text || "")),
              h("em", null, rangeText(range))
            );
          })
        )
      )
    ),
    h(HorizontalScrollbar, {
      scrollState,
      scrollRef,
    })
  );
}

function App() {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("");
  const [pipelineStep, setPipelineStep] = useState("");
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [jobId, setJobId] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [manifestPath, setManifestPath] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [actionEpisodes, setActionEpisodes] = useState([]);
  const [relations, setRelations] = useState([]);
  const [labelSets, setLabelSets] = useState(DEFAULT_RELATION_LABEL_SETS);
  const [currentTime, setCurrentTime] = useState(0);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [staticSessions, setStaticSessions] = useState([]);
  const [staticIndexBaseUrl, setStaticIndexBaseUrl] = useState(null);
  const [selectedStaticSessionId, setSelectedStaticSessionId] = useState("");
  const dirtyVersionRef = useRef(0);
  const lastSavedDirtyVersionRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const selectedStaticSession = useMemo(
    () => staticSessions.find((session) => session.id === selectedStaticSessionId) || null,
    [selectedStaticSessionId, staticSessions]
  );

  const conversations = useMemo(() => conversationsFromManifest(manifest), [manifest]);
  const duration = useMemo(
    () => manifestDuration(manifest, conversations, actionEpisodes),
    [manifest, conversations, actionEpisodes]
  );
  const {
    frames: videoFrames,
    loading: framesLoading,
    error: framesError,
  } = useVideoFrames(videoUrl, duration, FRAME_STEP_S);

  useEffect(() => {
    if (framesError) {
      setError(`Could not extract timeline frames: ${framesError}`);
    }
  }, [framesError]);

  useEffect(() => {
    dirtyVersionRef.current = dirtyVersion;
  }, [dirtyVersion]);

  const markDirty = useCallback(() => {
    setSaveStatus("unsaved");
    setDirtyVersion((prev) => prev + 1);
  }, []);

  const seek = useCallback(
    (time, updateVideo = true) => {
      const t = Math.max(0, Math.min(Number(time || 0), duration || Number.MAX_SAFE_INTEGER));
      setCurrentTime(t);
      const video = videoRef.current;
      if (updateVideo && video && Number.isFinite(t)) {
        const applySeek = () => {
          video.currentTime = t;
        };
        if (video.readyState >= 1) {
          applySeek();
        } else {
          video.addEventListener("loadedmetadata", applySeek, { once: true });
        }
      }
    },
    [duration]
  );

  const loadManifestAndGraph = useCallback(async (nextManifestPath) => {
    const graphResp = await fetch(`/api/dependency/graph?manifest_path=${encodeURIComponent(nextManifestPath)}`);
    const graphData = await readResponseJson(graphResp, "/api/dependency/graph");
    if (!graphResp.ok) {
      setError((graphData && graphData.error) || "Dependency graph request failed.");
      return false;
    }
    const labeledManifestPath = graphData.manifest_path || nextManifestPath;
    const manifestResp = await fetch(repoAssetUrl(labeledManifestPath, Date.now()), { cache: "no-store" });
    if (!manifestResp.ok) {
      setError("Could not load labeled manifest.");
      return false;
    }
    const rawManifest = await manifestResp.json();
    const nextManifest = readManifestObject(rawManifest);
    if (!nextManifest) {
      setError("Invalid manifest format.");
      return false;
    }
    setManifest(nextManifest);
    setManifestPath(labeledManifestPath);
    setActionEpisodes(graphData.action_episodes || nextManifest.action_episodes || []);
    setRelations(graphData.dependency_relations || nextManifest.dependency_relations || []);
    setLabelSets(graphData.relation_label_sets || nextManifest.metadata?.dependency_relation_label_sets || DEFAULT_RELATION_LABEL_SETS);
    dirtyVersionRef.current = 0;
    lastSavedDirtyVersionRef.current = 0;
    setDirtyVersion(0);
    setSaveStatus("");
    return true;
  }, []);

  const applyDependencyManifest = useCallback((nextManifest, nextManifestPath = null) => {
    setManifest(nextManifest);
    if (nextManifestPath) setManifestPath(nextManifestPath);
    setActionEpisodes(nextManifest.action_episodes || []);
    setRelations(nextManifest.dependency_relations || []);
    setLabelSets(nextManifest.metadata?.dependency_relation_label_sets || DEFAULT_RELATION_LABEL_SETS);
    dirtyVersionRef.current = 0;
    lastSavedDirtyVersionRef.current = 0;
    setDirtyVersion(0);
    setSaveStatus("");
  }, []);

  const loadStaticSession = useCallback(
    async (session, indexBaseUrl = staticIndexBaseUrl) => {
      if (!session || !indexBaseUrl) return false;
      setError("");
      setPipelineStep("");
      const manifestUrl = staticAssetUrl(session.manifest, indexBaseUrl, Date.now());
      const manifestResp = await fetch(manifestUrl, { cache: "no-store" });
      if (!manifestResp.ok) {
        setError(`Could not load sample manifest: ${session.id}`);
        return false;
      }
      const rawManifest = await manifestResp.json();
      const nextManifest = readManifestObject(rawManifest);
      if (!nextManifest) {
        setError(`Invalid sample manifest: ${session.id}`);
        return false;
      }
      applyDependencyManifest(nextManifest, session.manifest || `${session.id}_labeled.json`);
      setVideoUrl(staticAssetUrl(session.video, indexBaseUrl, Date.now()));
      setStatus(`sample: ${session.label || session.id}`);
      const url = new URL(window.location.href);
      url.searchParams.set("session", session.id);
      window.history.replaceState({}, "", url);
      return true;
    },
    [applyDependencyManifest, staticIndexBaseUrl]
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
          setStatus("Sample Mode");
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

  const submitFiles = useCallback(async (sessionFiles, speechFile = null) => {
    setError("");
    setPipelineStep("");
    setSaveStatus("");
    dirtyVersionRef.current = 0;
    lastSavedDirtyVersionRef.current = 0;
    setDirtyVersion(0);
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
    const audioFile = files.find((file) => file.name === `${stem}.wav`);
    if (!audioFile) {
      setError(`Folder must contain ${stem}.wav.`);
      return;
    }
    if (speechFile && canonicalSessionStem(speechFile.name) !== stem) {
      setError(`speech_path basename (${canonicalSessionStem(speechFile.name)}) must match ${stem}.`);
      return;
    }
    try {
      const fd = new FormData();
      files.forEach((file, idx) => {
        fd.append(`session_file_${idx}`, file, file.webkitRelativePath || file.name);
      });
      if (speechFile) fd.append("speech", speechFile);
      const resp = await fetch("/api/pipeline/run", { method: "POST", body: fd });
      const data = await readResponseJson(resp, "/api/pipeline/run");
      if (!resp.ok) {
        setError((data && data.error) || `Pipeline request failed (${resp.status}).`);
        return;
      }
      setJobId(data.job_id);
      setStatus("queued");
      setManifest(null);
      setActionEpisodes([]);
      setRelations([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const updateConversations = useCallback((nextConversations) => {
    setManifest((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        conversations: renumberConversations(nextConversations),
      };
    });
    markDirty();
  }, [markDirty]);

  useEffect(() => {
    if (!jobId) return undefined;
    const tick = async () => {
      try {
        const resp = await fetch(`/api/pipeline/status?job_id=${encodeURIComponent(jobId)}`);
        const data = await readResponseJson(resp, "/api/pipeline/status");
        if (!resp.ok) {
          setError((data && data.error) || "Status request failed.");
          setJobId(null);
          return;
        }
        setStatus(String(data.status || ""));
        setPipelineStep(data.step != null && data.step !== "" ? String(data.step) : "");
        if (data.status === "error") {
          setError(String(data.error || "Pipeline failed."));
          setJobId(null);
          return;
        }
        if (!data.error) setError("");
        if (data.status === "done" && data.manifest_path && data.video_path) {
          setJobId(null);
          setPipelineStep("");
          setVideoUrl(repoAssetUrl(data.video_path, Date.now()));
          await loadManifestAndGraph(data.manifest_path);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setJobId(null);
      }
    };
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [jobId, loadManifestAndGraph]);

  const saveGraph = useCallback(async (options = {}) => {
    if (!manifestPath) {
      setError("Run pipeline first so there is a manifest to save.");
      return;
    }
    if (IS_STATIC_MODE) {
      const currentConversations = conversationsFromManifest(manifest);
      const nextManifest = {
        ...(manifest || {}),
        conversations: currentConversations,
        action_episodes: actionEpisodes,
        dependency_relations: relations,
        metadata: {
          ...((manifest && manifest.metadata) || {}),
          dependency_relation_label_sets: labelSets,
        },
      };
      setManifest(nextManifest);
      const stem = selectedStaticSession?.id || canonicalSessionStem(manifestPath) || "session";
      downloadJson(`${stem}_labeled.json`, nextManifest);
      lastSavedDirtyVersionRef.current = dirtyVersionRef.current;
      setSaveStatus("saved");
      return;
    }
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      setSaveStatus("unsaved");
      return;
    }
    const isAuto = Boolean(options.auto);
    const versionAtStart = dirtyVersionRef.current;
    saveInFlightRef.current = true;
    setSaveStatus(isAuto ? "auto-saving" : "saving");
    setError("");
    const currentConversations = conversationsFromManifest(manifest);
    try {
      const resp = await fetch("/api/dependency/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest_path: manifestPath,
          action_episodes: actionEpisodes,
          dependency_relations: relations,
          conversations: currentConversations,
        }),
      });
      const data = await readResponseJson(resp, "/api/dependency/save");
      if (!resp.ok) {
        setError((data && data.error) || "Dependency save failed.");
        setSaveStatus("");
        return;
      }
      lastSavedDirtyVersionRef.current = versionAtStart;
      if (dirtyVersionRef.current === versionAtStart) {
        setManifestPath(data.manifest_path || manifestPath);
        setActionEpisodes(data.action_episodes || actionEpisodes);
        setRelations(data.dependency_relations || relations);
        setLabelSets(data.relation_label_sets || labelSets);
        setSaveStatus("saved");
      } else {
        setSaveStatus("unsaved");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaveStatus("unsaved");
    } finally {
      saveInFlightRef.current = false;
      if (pendingSaveRef.current || dirtyVersionRef.current !== lastSavedDirtyVersionRef.current) {
        pendingSaveRef.current = false;
        setTimeout(() => {
          if (!saveInFlightRef.current && dirtyVersionRef.current !== lastSavedDirtyVersionRef.current) {
            void saveGraph({ auto: true });
          }
        }, 1200);
      }
    }
  }, [actionEpisodes, labelSets, manifest, manifestPath, relations, selectedStaticSession]);

  useEffect(() => {
    if (IS_STATIC_MODE || !manifestPath || dirtyVersion === 0 || dirtyVersion === lastSavedDirtyVersionRef.current) {
      return undefined;
    }
    const id = setTimeout(() => {
      void saveGraph({ auto: true });
    }, 1200);
    return () => clearTimeout(id);
  }, [dirtyVersion, manifestPath, saveGraph]);

  const selectStaticSession = useCallback(
    (sessionId) => {
      setSelectedStaticSessionId(sessionId);
      const session = staticSessions.find((item) => item.id === sessionId);
      if (session) void loadStaticSession(session, staticIndexBaseUrl);
    },
    [loadStaticSession, staticIndexBaseUrl, staticSessions]
  );

  const isSaving = !IS_STATIC_MODE && (saveStatus === "saving" || saveStatus === "auto-saving");

  return h(
    "main",
    { className: "app dependency-app" },
    h(
      "header",
      { className: "toolbar dependency-toolbar" },
      h("h1", null, "Moving Out Dependency Parsing")
    ),
    IS_STATIC_MODE
      ? h(StaticSessionPicker, {
          sessions: staticSessions,
          selectedId: selectedStaticSessionId,
          onSelect: selectStaticSession,
        })
      : h(SessionUpload, {
          onSubmitFiles: submitFiles,
          onError: (msg) => setError(msg),
          disabled: Boolean(jobId),
        }),
    h(
      "section",
      { className: "status dependency-status" },
      status && h("div", null, pipelineStep ? `status: ${status} | step: ${pipelineStep}` : `status: ${status}`),
      manifestPath && h("div", { className: "manifest-line" }, `manifest: ${manifestPath}`),
      error && h("div", { className: "status-error" }, error),
      h(
        "div",
        { className: "dependency-actions" },
        h("button", { type: "button", className: "btn-primary", disabled: !manifestPath || isSaving, onClick: () => saveGraph() }, IS_STATIC_MODE ? "Download JSON" : (isSaving ? "Saving..." : "Save graph")),
        saveStatus === "unsaved" && h("span", null, "unsaved changes"),
        !IS_STATIC_MODE && saveStatus === "auto-saving" && h("span", null, "auto-saving..."),
        saveStatus === "saved" && h("span", null, IS_STATIC_MODE ? "downloaded" : "saved"),
        h("span", null, `${actionEpisodes.length} action episodes | ${relations.length} relations`)
      )
    ),
    manifest && videoUrl
      ? h(DependencyGraph, {
          manifest,
          actionEpisodes,
          relations,
          labelSets,
          videoSrc: videoUrl,
          videoRef,
          videoFrames,
          framesLoading,
          currentTime,
          onSeek: seek,
          onMediaError: setError,
          onActionEpisodesChange: (nextEpisodes) => {
            setActionEpisodes(nextEpisodes);
            markDirty();
          },
          onConversationsChange: updateConversations,
          onRelationsChange: (nextRelations) => {
            setRelations(nextRelations);
            markDirty();
          },
        })
      : h("section", { className: "dependency-panel empty-panel" }, h("p", { className: "empty" }, "Run a pipeline or saved dataset to build the dependency graph."))
  );
}

createRoot(document.getElementById("root")).render(h(App, null));
