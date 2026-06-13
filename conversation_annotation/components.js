/**
 * Stable id for a sentence; must match Python make_key in web_visualization_server.py
 * (time start/end .2f + speaker + first 30 chars of text).
 */
export function makeSentenceKeyForEdit(timeRange, speaker, text) {
  const tr = timeRange || [];
  const start = Number(tr[0] ?? 0);
  const end = tr.length > 1 ? Number(tr[1] ?? start) : start;
  const preview = String(text || "").slice(0, 30);
  return `${start.toFixed(2)}_${end.toFixed(2)}_${speaker || ""}_${preview}`;
}

export function flattenUtterances(manifest) {
  const items = [];
  const convCount = Array.isArray(manifest?.conversations) ? manifest.conversations.length : 0;
  const paraCount = Array.isArray(manifest?.paragraphs) ? manifest.paragraphs.length : 0;
  const segCount = Array.isArray(manifest?.segments) ? manifest.segments.length : 0;
  console.debug("[webviz] flattenUtterances input", {
    schema_version: manifest?.metadata?.schema_version ?? null,
    conversations: convCount,
    paragraphs: paraCount,
    segments: segCount,
  });

  const conversations = manifest.conversations || [];
  for (let cIdx = 0; cIdx < conversations.length; cIdx++) {
    const conv = conversations[cIdx];
    const convRange = conv.time_range || [];
    const sents = conv.sentences || [];
    if (!sents.length) continue;
    const start =
      typeof convRange[0] === "number"
        ? convRange[0]
        : Number(sents[0].time_range?.[0] || 0);
    const end =
      typeof convRange[1] === "number"
        ? convRange[1]
        : Number(sents[sents.length - 1].time_range?.[1] || start);
    const text = sents.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ");
    const speakers = [...new Set(sents.map((s) => s.speaker || "?").filter(Boolean))];
    const speakerStr = speakers.length === 1 ? speakers[0] : speakers.join("/");
    const functions = [...new Set(sents.map((s) => s.communication_function || "").filter(Boolean))];
    const roles = [...new Set(sents.map((s) => s.conversation_role || "").filter(Boolean))];
    items.push({
      conversation_index: cIdx,
      conversation_id: conv.conversation_id || `conv_${String(cIdx).padStart(3, "0")}`,
      has_previous: cIdx > 0,
      has_next: cIdx < conversations.length - 1,
      paragraph_index: cIdx,
      speaker: speakerStr,
      text,
      time_range: [start, end],
      action_window: conv.action_window || [start, end + 5],
      follow_label: conv.follow_label || "unclear",
      collapsed: Boolean(conv.collapsed),
      communication_category:
        conv.communication_category ||
        sents[0].communication_category ||
        "knowledge share",
      conversation_roles: roles,
      communication_functions: functions,
      sentences: sents,
      _segment_time_range: conv.action_window || [start, end + 5],
    });
  }
  if (items.length > 0) {
    console.debug("[webviz] using conversations (conversation-level cards)", { count: items.length });
    return items.sort((a, b) => Number(a.time_range?.[0] || 0) - Number(b.time_range?.[0] || 0));
  }

  // Schema v2: paragraphs -> sentences (paragraph_index = manifest index, stable for API edits)
  const paragraphs = manifest.paragraphs || [];
  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const par = paragraphs[pIdx];
    const parRange = par.time_range || [];
    const sents = par.sentences || par.speech_annotations || [];
    if (!sents.length) continue;
    const start =
      typeof parRange[0] === "number"
        ? parRange[0]
        : Number(sents[0].time_range?.[0] || 0);
    const end =
      typeof parRange[1] === "number"
        ? parRange[1]
        : Number(sents[sents.length - 1].time_range?.[1] || start);
    const text = sents.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ");
    const category =
      par.communication_category ||
      sents[0].communication_category ||
      "knowledge share";
    const allFiller = sents.every((s) => s.is_filler_like === true);
    // Get unique speakers in this paragraph
    const speakers = [...new Set(sents.map((s) => s.speaker || "?").filter(Boolean))];
    const speakerStr = speakers.length === 1 ? speakers[0] : speakers.join("/");
    items.push({
      paragraph_index: pIdx,
      conversation_index: pIdx,
      has_previous: pIdx > 0,
      has_next: pIdx < paragraphs.length - 1,
      speaker: speakerStr, // Show speaker(s) for this paragraph
      text,
      time_range: [start, end],
      communication_category: category,
      follow_label: par.follow_label || "unclear",
      action_window: par.action_window || [start, end + 5],
      collapsed: false,
      is_filler_like: allFiller,
      sentences: sents,
      _segment_time_range: parRange.length ? parRange : [start, end],
    });
  }
  if (items.length > 0) {
    console.debug("[webviz] using paragraphs (paragraph-level cards)", { count: items.length });
    return items.sort((a, b) => Number(a.time_range?.[0] || 0) - Number(b.time_range?.[0] || 0));
  }

  // Schema v1 fallback: segments -> speech_annotations
  let v1SegIdx = 0;
  for (const seg of manifest.segments || []) {
    for (const ann of seg.speech_annotations || []) {
      items.push({
        ...ann,
        paragraph_index: v1SegIdx,
        sentences: [ann],
        _segment_time_range: seg.time_range || [],
      });
      v1SegIdx += 1;
    }
  }
  console.debug("[webviz] using segments[].speech_annotations[]", { count: items.length });
  return items.sort((a, b) => Number(a.time_range?.[0] || 0) - Number(b.time_range?.[0] || 0));
}

export function isRelevantUtterance(u, showFiller) {
  if (showFiller) return true;
  if ((u.communication_category || "").trim().toLowerCase() === "confirmation") return false;
  if (u.is_filler_like === true) return false;
  return true;
}

/** Timeline / labeling: exclude only confirmation (per web viewer spec). */
export function isNonConfirmationUtterance(u) {
  return (u.communication_category || "").trim().toLowerCase() !== "confirmation";
}

export function categoryColor(category) {
  const c = String(category || "").toLowerCase();
  if (c.includes("confirmation")) return "#7d899f";
  if (c.includes("error") || c.includes("replan")) return "#f06292";
  if (c.includes("high-level") || c.includes("high level")) return "#ffb74d";
  if (c.includes("low-level") || c.includes("low level")) return "#ffd54f";
  return "#4fc3f7";
}

export function followColor(label) {
  const c = String(label || "").toLowerCase();
  if (c === "follow") return "#66bb6a";
  if (c === "unfollow") return "#ef5350";
  return "#7d899f";
}

export function getActiveUtterances(items, t) {
  return items.filter((u) => {
    const t0 = Number(u.time_range?.[0] || 0);
    const t1 = Number(u.time_range?.[1] || 0);
    return t0 <= t && t <= t1;
  });
}
